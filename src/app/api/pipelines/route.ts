import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";
import { canAccessHive, canMutateHive } from "@/auth/users";
import { startPipelineRun } from "@/pipelines/service";
import type { Sql, TransactionSql } from "postgres";

type GoalRow = {
  hive_id: string;
  project_id: string | null;
  session_id: string | null;
  title: string;
  description: string | null;
};

type PipelineTemplateStep = {
  id: string;
  order: number;
  slug: string;
  name: string;
  roleSlug: string;
  duty: string;
  qaRequired: boolean;
  maxRuntimeSeconds: number;
  maxRetries: number;
  maxCostCents: number | null;
  outputContract: Record<string, unknown>;
  acceptanceCriteria: string | null;
  failurePolicy: string;
  driftCheck: Record<string, unknown>;
};

type PipelineTemplateRow = {
  id: string;
  scope: string;
  hiveId: string | null;
  slug: string;
  name: string;
  description: string | null;
  department: string;
  mode: string;
  defaultSlaSeconds: number;
  maxTotalCostCents: number | null;
  finalOutputContract: Record<string, unknown>;
  dashboardVisibilityPolicy: string;
  version: number;
  active: boolean;
  stepCount: number;
  steps: PipelineTemplateStep[];
};

type PipelineRunStep = PipelineTemplateStep & {
  stepRunId: string | null;
  taskId: string | null;
  status: string;
  resultSummary: string | null;
  current: boolean;
  completedAt: string | null;
};

type PipelineRunRow = {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  status: string;
  sourceTaskId: string | null;
  goalId: string | null;
  projectId: string | null;
  supervisorHandoff: string | null;
  currentStepId: string | null;
  currentStepName: string | null;
  currentStepOrder: number | null;
  steps: PipelineRunStep[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type SourceTaskRow = {
  id: string;
  title: string;
  brief: string;
};

type ProcedureStepInput = Partial<{
  id: string;
  order: number;
  stepOrder: number;
  slug: string;
  name: string;
  roleSlug: string;
  role_slug: string;
  duty: string;
  qaRequired: boolean;
  qa_required: boolean;
  maxRuntimeSeconds: number;
  max_runtime_seconds: number;
  maxRetries: number;
  max_retries: number;
  maxCostCents: number | null;
  max_cost_cents: number | null;
  outputContract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  acceptanceCriteria: string;
  acceptance_criteria: string;
  failurePolicy: string;
  failure_policy: string;
  driftCheck: Record<string, unknown>;
  drift_check: Record<string, unknown>;
}>;

type ProcedureTemplateInput = Partial<{
  hiveId: string;
  templateId: string;
  name: string;
  slug: string;
  description: string | null;
  department: string;
  mode: string;
  active: boolean;
  defaultSlaSeconds: number;
  default_sla_seconds: number;
  maxTotalCostCents: number | null;
  max_total_cost_cents: number | null;
  finalOutputContract: Record<string, unknown>;
  final_output_contract: Record<string, unknown>;
  dashboardVisibilityPolicy: string;
  dashboard_visibility_policy: string;
  steps: unknown[];
}>;

type NormalizedProcedureStep = {
  order: number;
  slug: string;
  name: string;
  roleSlug: string;
  duty: string;
  qaRequired: boolean;
  maxRuntimeSeconds: number;
  maxRetries: number;
  maxCostCents: number | null;
  outputContract: Record<string, unknown>;
  acceptanceCriteria: string;
  failurePolicy: string;
  driftCheck: Record<string, unknown>;
};

type ExistingTemplateRow = {
  id: string;
  scope: string;
  hive_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  department: string;
  mode: string;
  default_sla_seconds: number;
  max_total_cost_cents: number | null;
  final_output_contract: Record<string, unknown>;
  dashboard_visibility_policy: string;
  version: number;
  active: boolean;
};

const TEMPLATE_MODES = new Set(["production", "research", "implementation", "qa", "monitoring", "support"]);
const DASHBOARD_VISIBILITY_POLICIES = new Set(["summary_artifacts_only", "artifact_only", "debug_full_transcript"]);
const FAILURE_POLICIES = new Set(["retry_then_fail", "fail_fast", "ask_owner", "continue_with_warning", "skip_optional"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || "procedure";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableStringValue(value: unknown) {
  if (value === null) return null;
  const text = stringValue(value);
  return text || null;
}

function positiveIntValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function boundedRetryValue(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(3, Math.max(0, Math.trunc(value)));
}

function nonNegativeNullableIntValue(value: unknown, fallback: number | null) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function recordValue(value: unknown, fallback: Record<string, unknown>) {
  return isRecord(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function uniqueStepSlug(base: string, used: Set<string>) {
  const root = safeSlug(base);
  let candidate = root;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${root.slice(0, 100 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeSteps(rawSteps: unknown, active: boolean): { steps: NormalizedProcedureStep[] } | { error: string } {
  if (!Array.isArray(rawSteps)) {
    if (active) return { error: "steps are required when approving a procedure" };
    return { steps: [] };
  }
  if (active && rawSteps.length === 0) return { error: "at least one step is required when approving a procedure" };

  const usedSlugs = new Set<string>();
  const seenOrders = new Set<number>();
  const parsed = rawSteps.map((raw, index): NormalizedProcedureStep | { error: string } => {
    if (!isRecord(raw)) return { error: `steps[${index}] must be an object` };
    const input = raw as ProcedureStepInput;
    const rawOrder = input.order ?? input.stepOrder;
    if (typeof rawOrder !== "number" || !Number.isFinite(rawOrder) || rawOrder <= 0) {
      return { error: `steps[${index}].order is required` };
    }
    const order = Math.trunc(rawOrder);
    if (seenOrders.has(order)) return { error: `steps[${index}].order must be unique` };
    seenOrders.add(order);

    const name = stringValue(input.name);
    const roleSlug = stringValue(input.roleSlug ?? input.role_slug);
    const duty = stringValue(input.duty);
    if (!name) return { error: `steps[${index}].name is required` };
    if (!roleSlug) return { error: `steps[${index}].roleSlug is required` };
    if (!duty) return { error: `steps[${index}].duty is required` };

    const failurePolicy = stringValue(input.failurePolicy ?? input.failure_policy) || "retry_then_fail";
    if (!FAILURE_POLICIES.has(failurePolicy)) return { error: `steps[${index}].failurePolicy is invalid` };

    return {
      order,
      slug: uniqueStepSlug(stringValue(input.slug) || name, usedSlugs),
      name,
      roleSlug,
      duty,
      qaRequired: booleanValue(input.qaRequired ?? input.qa_required, false),
      maxRuntimeSeconds: positiveIntValue(input.maxRuntimeSeconds ?? input.max_runtime_seconds, 300),
      maxRetries: boundedRetryValue(input.maxRetries ?? input.max_retries, 1),
      maxCostCents: nonNegativeNullableIntValue(input.maxCostCents ?? input.max_cost_cents, null),
      outputContract: recordValue(input.outputContract ?? input.output_contract, { requiredFields: ["summary", "evidence"] }),
      acceptanceCriteria: stringValue(input.acceptanceCriteria ?? input.acceptance_criteria) || "Step output satisfies the duty and cites evidence.",
      failurePolicy,
      driftCheck: recordValue(input.driftCheck ?? input.drift_check, { mode: "source_similarity", threshold: 0.3 }),
    };
  });

  const error = parsed.find((step): step is { error: string } => "error" in step);
  if (error) return error;
  const steps = (parsed as NormalizedProcedureStep[])
    .sort((a, b) => a.order - b.order)
    .map((step, index) => ({ ...step, order: index + 1 }));
  return { steps };
}

async function requireHiveAccess(user: { id: string; isSystemOwner: boolean }, hiveId: string) {
  if (user.isSystemOwner) return null;
  const hasAccess = await canAccessHive(sql, user.id, hiveId);
  return hasAccess ? null : jsonError("Forbidden", 403);
}

async function requireHiveMutationAccess(user: { id: string; isSystemOwner: boolean }, hiveId: string) {
  if (user.isSystemOwner) return null;
  const hasAccess = await canMutateHive(sql, user.id, hiveId);
  return hasAccess ? null : jsonError("Forbidden: caller cannot manage procedures for this hive", 403);
}

function requiredFieldsFromContract(contract: Record<string, unknown>) {
  const requiredFields = contract.requiredFields;
  if (!Array.isArray(requiredFields)) return [];
  return requiredFields
    .filter((field): field is string => typeof field === "string")
    .map((field) => field.trim())
    .filter(Boolean);
}

function validateExecutionReadyProcedure(input: {
  finalOutputContract: Record<string, unknown>;
  steps: Array<Pick<NormalizedProcedureStep, "outputContract" | "driftCheck">>;
}) {
  if (requiredFieldsFromContract(input.finalOutputContract).length === 0) {
    return "finalOutputContract.requiredFields is required before approving a procedure";
  }
  if (input.steps.length === 0) return "at least one step is required when approving a procedure";
  const invalidOutputIndex = input.steps.findIndex((step) => requiredFieldsFromContract(step.outputContract).length === 0);
  if (invalidOutputIndex >= 0) {
    return `steps[${invalidOutputIndex}].outputContract.requiredFields is required before approving a procedure`;
  }
  const invalidDriftIndex = input.steps.findIndex((step) => typeof step.driftCheck.mode !== "string" || step.driftCheck.mode.trim().length === 0);
  if (invalidDriftIndex >= 0) {
    return `steps[${invalidDriftIndex}].driftCheck.mode is required before approving a procedure`;
  }
  return null;
}

async function loadStepsForValidation(templateId: string) {
  return sql<Array<Pick<NormalizedProcedureStep, "outputContract" | "driftCheck">>>`
    SELECT output_contract AS "outputContract", drift_check AS "driftCheck"
    FROM pipeline_steps
    WHERE template_id = ${templateId}
    ORDER BY step_order ASC
  `;
}

async function parseJsonBody(req: Request) {
  try {
    return await req.json() as unknown;
  } catch {
    return null;
  }
}

async function assertRolesExist(roleSlugs: string[]) {
  const uniqueRoleSlugs = Array.from(new Set(roleSlugs));
  if (uniqueRoleSlugs.length === 0) return null;
  const existing = await sql<{ slug: string }[]>`
    SELECT slug
    FROM role_templates
    WHERE slug = ANY(${uniqueRoleSlugs}::varchar[])
  `;
  const existingSlugs = new Set(existing.map((row) => row.slug));
  const missing = uniqueRoleSlugs.filter((slug) => !existingSlugs.has(slug));
  return missing.length > 0 ? `roleSlug does not exist: ${missing.join(", ")}` : null;
}

async function loadTemplate(templateId: string, hiveId: string) {
  const [template] = await sql<ExistingTemplateRow[]>`
    SELECT
      id,
      scope,
      hive_id,
      slug,
      name,
      description,
      department,
      mode,
      default_sla_seconds,
      max_total_cost_cents,
      final_output_contract,
      dashboard_visibility_policy,
      version,
      active
    FROM pipeline_templates
    WHERE id = ${templateId}
      AND hive_id = ${hiveId}
      AND scope = 'hive'
    LIMIT 1
  `;
  return template ?? null;
}

async function loadTemplateForResponse(templateId: string) {
  const [template] = await sql<PipelineTemplateRow[]>`
    SELECT
      pt.id,
      pt.scope,
      pt.hive_id AS "hiveId",
      pt.slug,
      pt.name,
      pt.description,
      pt.department,
      pt.mode,
      pt.default_sla_seconds AS "defaultSlaSeconds",
      pt.max_total_cost_cents AS "maxTotalCostCents",
      pt.final_output_contract AS "finalOutputContract",
      pt.dashboard_visibility_policy AS "dashboardVisibilityPolicy",
      pt.version,
      pt.active,
      COUNT(ps.id)::int AS "stepCount",
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', ps.id,
            'order', ps.step_order,
            'slug', ps.slug,
            'name', ps.name,
            'roleSlug', ps.role_slug,
            'duty', ps.duty,
            'qaRequired', ps.qa_required,
            'maxRuntimeSeconds', ps.max_runtime_seconds,
            'maxRetries', ps.max_retries,
            'maxCostCents', ps.max_cost_cents,
            'outputContract', ps.output_contract,
            'acceptanceCriteria', ps.acceptance_criteria,
            'failurePolicy', ps.failure_policy,
            'driftCheck', ps.drift_check
          )
          ORDER BY ps.step_order ASC
        ) FILTER (WHERE ps.id IS NOT NULL),
        '[]'::jsonb
      ) AS steps
    FROM pipeline_templates pt
    LEFT JOIN pipeline_steps ps ON ps.template_id = pt.id
    WHERE pt.id = ${templateId}
    GROUP BY pt.id
  `;
  return template ?? null;
}

async function insertProcedureSteps(db: Sql | TransactionSql, templateId: string, steps: NormalizedProcedureStep[]) {
  for (const step of steps) {
    await db`
      INSERT INTO pipeline_steps (
        template_id,
        step_order,
        slug,
        name,
        role_slug,
        duty,
        qa_required,
        max_runtime_seconds,
        max_retries,
        max_cost_cents,
        output_contract,
        acceptance_criteria,
        failure_policy,
        drift_check
      ) VALUES (
        ${templateId},
        ${step.order},
        ${step.slug},
        ${step.name},
        ${step.roleSlug},
        ${step.duty},
        ${step.qaRequired},
        ${step.maxRuntimeSeconds},
        ${step.maxRetries},
        ${step.maxCostCents},
        ${sql.json(step.outputContract as unknown as Parameters<typeof sql.json>[0])},
        ${step.acceptanceCriteria},
        ${step.failurePolicy},
        ${sql.json(step.driftCheck as unknown as Parameters<typeof sql.json>[0])}
      )
    `;
  }
}

export async function GET(req: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const params = parseSearchParams(req.url);
  const hiveId = params.get("hiveId");
  if (!hiveId) return jsonError("hiveId is required", 400);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden", 403);
  }

  const runLimit = params.getInt("runLimit", 25, { min: 1, max: 100 });
  const includeInactiveParam = params.get("includeInactive")?.toLowerCase() ?? "";
  const includeInactive = includeInactiveParam === "true" || includeInactiveParam === "1";

  const templates = await sql<PipelineTemplateRow[]>`
    SELECT
      pt.id,
      pt.scope,
      pt.hive_id AS "hiveId",
      pt.slug,
      pt.name,
      pt.description,
      pt.department,
      pt.mode,
      pt.default_sla_seconds AS "defaultSlaSeconds",
      pt.max_total_cost_cents AS "maxTotalCostCents",
      pt.final_output_contract AS "finalOutputContract",
      pt.dashboard_visibility_policy AS "dashboardVisibilityPolicy",
      pt.version,
      pt.active,
      COUNT(ps.id)::int AS "stepCount",
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', ps.id,
            'order', ps.step_order,
            'slug', ps.slug,
            'name', ps.name,
            'roleSlug', ps.role_slug,
            'duty', ps.duty,
            'qaRequired', ps.qa_required,
            'maxRuntimeSeconds', ps.max_runtime_seconds,
            'maxRetries', ps.max_retries,
            'maxCostCents', ps.max_cost_cents,
            'outputContract', ps.output_contract,
            'acceptanceCriteria', ps.acceptance_criteria,
            'failurePolicy', ps.failure_policy,
            'driftCheck', ps.drift_check
          )
          ORDER BY ps.step_order ASC
        ) FILTER (WHERE ps.id IS NOT NULL),
        '[]'::jsonb
      ) AS steps
    FROM pipeline_templates pt
    LEFT JOIN pipeline_steps ps ON ps.template_id = pt.id
    WHERE (${includeInactive} = true OR pt.active = true)
      AND (pt.scope = 'global' OR pt.hive_id = ${hiveId})
    GROUP BY pt.id
    ORDER BY pt.active DESC, pt.department ASC, pt.name ASC, pt.version DESC
  `;

  const runs = await sql<PipelineRunRow[]>`
    SELECT
      pr.id,
      pr.template_id AS "templateId",
      pt.name AS "templateName",
      pr.template_version AS "templateVersion",
      pr.status,
      pr.source_task_id AS "sourceTaskId",
      pr.goal_id AS "goalId",
      pr.project_id AS "projectId",
      pr.supervisor_handoff AS "supervisorHandoff",
      pr.current_step_id AS "currentStepId",
      current_step.name AS "currentStepName",
      current_step.step_order AS "currentStepOrder",
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', template_step.id,
            'order', template_step.step_order,
            'slug', template_step.slug,
            'name', template_step.name,
            'roleSlug', template_step.role_slug,
            'duty', template_step.duty,
            'qaRequired', template_step.qa_required,
            'maxRuntimeSeconds', template_step.max_runtime_seconds,
            'maxRetries', template_step.max_retries,
            'maxCostCents', template_step.max_cost_cents,
            'outputContract', template_step.output_contract,
            'acceptanceCriteria', template_step.acceptance_criteria,
            'failurePolicy', template_step.failure_policy,
            'driftCheck', template_step.drift_check,
            'stepRunId', psr.id,
            'taskId', psr.task_id,
            'status', COALESCE(
              psr.status,
              CASE WHEN template_step.id = pr.current_step_id THEN 'running' ELSE 'pending' END
            ),
            'resultSummary', psr.result_summary,
            'current', template_step.id = pr.current_step_id,
            'completedAt', psr.completed_at
          )
          ORDER BY template_step.step_order ASC
        ) FILTER (WHERE template_step.id IS NOT NULL),
        '[]'::jsonb
      ) AS steps,
      pr.created_at AS "createdAt",
      pr.updated_at AS "updatedAt",
      pr.completed_at AS "completedAt"
    FROM pipeline_runs pr
    JOIN pipeline_templates pt ON pt.id = pr.template_id
    LEFT JOIN pipeline_steps current_step ON current_step.id = pr.current_step_id
    LEFT JOIN pipeline_steps template_step ON template_step.template_id = pt.id
    LEFT JOIN pipeline_step_runs psr ON psr.run_id = pr.id AND psr.step_id = template_step.id
    WHERE pr.hive_id = ${hiveId}
    GROUP BY pr.id, pt.name, current_step.name, current_step.step_order
    ORDER BY pr.created_at DESC
    LIMIT ${runLimit}
  `;

  return jsonOk({ templates, runs });
}

export async function PUT(req: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const body = await parseJsonBody(req);
  if (!isRecord(body)) return jsonError("Invalid JSON body", 400);
  const input = body as ProcedureTemplateInput;

  const hiveId = stringValue(input.hiveId);
  const name = stringValue(input.name);
  const department = stringValue(input.department);
  const active = booleanValue(input.active, false);
  const slug = safeSlug(stringValue(input.slug) || name);
  const mode = stringValue(input.mode) || "production";
  const dashboardVisibilityPolicy = stringValue(input.dashboardVisibilityPolicy ?? input.dashboard_visibility_policy) || "summary_artifacts_only";
  const defaultSlaSeconds = positiveIntValue(input.defaultSlaSeconds ?? input.default_sla_seconds, 900);
  const maxTotalCostCents = nonNegativeNullableIntValue(input.maxTotalCostCents ?? input.max_total_cost_cents, null);
  const finalOutputContract = recordValue(
    input.finalOutputContract ?? input.final_output_contract,
    { artifactKind: "procedure", requiredFields: ["summary", "evidence"] },
  );

  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!name) return jsonError("name is required", 400);
  if (!slug) return jsonError("slug is required", 400);
  if (!department) return jsonError("department is required", 400);
  if (!TEMPLATE_MODES.has(mode)) return jsonError("mode is invalid", 400);
  if (!DASHBOARD_VISIBILITY_POLICIES.has(dashboardVisibilityPolicy)) {
    return jsonError("dashboardVisibilityPolicy is invalid", 400);
  }

  const denied = await requireHiveMutationAccess(authz.user, hiveId);
  if (denied) return denied;

  const [hive] = await sql<{ id: string }[]>`SELECT id FROM hives WHERE id = ${hiveId} LIMIT 1`;
  if (!hive) return jsonError("hive not found", 404);

  const normalizedSteps = normalizeSteps(input.steps, active);
  if ("error" in normalizedSteps) return jsonError(normalizedSteps.error, 400);
  const missingRoles = await assertRolesExist(normalizedSteps.steps.map((step) => step.roleSlug));
  if (missingRoles) return jsonError(missingRoles, 400);
  if (active) {
    const validationError = validateExecutionReadyProcedure({ finalOutputContract, steps: normalizedSteps.steps });
    if (validationError) return jsonError(validationError, 400);
  }

  const [versionRow] = await sql<{ version: number }[]>`
    SELECT COALESCE(MAX(version), 0)::int + 1 AS version
    FROM pipeline_templates
    WHERE scope = 'hive'
      AND hive_id = ${hiveId}
      AND slug = ${slug}
  `;

  const templateId = await sql.begin(async (tx) => {
    const [template] = await tx<{ id: string }[]>`
      INSERT INTO pipeline_templates (
        scope,
        hive_id,
        slug,
        name,
        department,
        description,
        mode,
        default_sla_seconds,
        max_total_cost_cents,
        final_output_contract,
        dashboard_visibility_policy,
        version,
        active
      ) VALUES (
        'hive',
        ${hiveId},
        ${slug},
        ${name},
        ${department},
        ${nullableStringValue(input.description)},
        ${mode},
        ${defaultSlaSeconds},
        ${maxTotalCostCents},
        ${sql.json(finalOutputContract as unknown as Parameters<typeof sql.json>[0])},
        ${dashboardVisibilityPolicy},
        ${versionRow.version},
        ${active}
      )
      RETURNING id
    `;
    await insertProcedureSteps(tx, template.id, normalizedSteps.steps);
    return template.id;
  });

  const template = await loadTemplateForResponse(templateId);
  return jsonOk(template, 201);
}

export async function PATCH(req: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const body = await parseJsonBody(req);
  if (!isRecord(body)) return jsonError("Invalid JSON body", 400);
  const input = body as ProcedureTemplateInput;
  const hiveId = stringValue(input.hiveId);
  const templateId = stringValue(input.templateId);
  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!templateId) return jsonError("templateId is required", 400);

  const denied = await requireHiveMutationAccess(authz.user, hiveId);
  if (denied) return denied;

  const existing = await loadTemplate(templateId, hiveId);
  if (!existing) return jsonError("procedure template not found", 404);

  const stepsProvided = Object.prototype.hasOwnProperty.call(input, "steps");
  const active = booleanValue(input.active, existing.active);
  const name = Object.prototype.hasOwnProperty.call(input, "name") ? stringValue(input.name) : existing.name;
  const slug = Object.prototype.hasOwnProperty.call(input, "slug")
    ? safeSlug(stringValue(input.slug) || name)
    : existing.slug;
  const department = Object.prototype.hasOwnProperty.call(input, "department") ? stringValue(input.department) : existing.department;
  const mode = Object.prototype.hasOwnProperty.call(input, "mode") ? stringValue(input.mode) : existing.mode;
  const dashboardVisibilityPolicy = Object.prototype.hasOwnProperty.call(input, "dashboardVisibilityPolicy") || Object.prototype.hasOwnProperty.call(input, "dashboard_visibility_policy")
    ? stringValue(input.dashboardVisibilityPolicy ?? input.dashboard_visibility_policy)
    : existing.dashboard_visibility_policy;
  const defaultSlaSeconds = Object.prototype.hasOwnProperty.call(input, "defaultSlaSeconds") || Object.prototype.hasOwnProperty.call(input, "default_sla_seconds")
    ? positiveIntValue(input.defaultSlaSeconds ?? input.default_sla_seconds, existing.default_sla_seconds)
    : existing.default_sla_seconds;
  const maxTotalCostCents = Object.prototype.hasOwnProperty.call(input, "maxTotalCostCents") || Object.prototype.hasOwnProperty.call(input, "max_total_cost_cents")
    ? nonNegativeNullableIntValue(input.maxTotalCostCents ?? input.max_total_cost_cents, existing.max_total_cost_cents)
    : existing.max_total_cost_cents;
  const finalOutputContract = Object.prototype.hasOwnProperty.call(input, "finalOutputContract") || Object.prototype.hasOwnProperty.call(input, "final_output_contract")
    ? recordValue(input.finalOutputContract ?? input.final_output_contract, existing.final_output_contract)
    : existing.final_output_contract;
  const description = Object.prototype.hasOwnProperty.call(input, "description")
    ? nullableStringValue(input.description)
    : existing.description;

  if (!name) return jsonError("name is required", 400);
  if (!slug) return jsonError("slug is required", 400);
  if (!department) return jsonError("department is required", 400);
  if (!TEMPLATE_MODES.has(mode)) return jsonError("mode is invalid", 400);
  if (!DASHBOARD_VISIBILITY_POLICIES.has(dashboardVisibilityPolicy)) {
    return jsonError("dashboardVisibilityPolicy is invalid", 400);
  }

  const [slugConflict] = await sql<{ id: string }[]>`
    SELECT id
    FROM pipeline_templates
    WHERE scope = 'hive'
      AND hive_id = ${hiveId}
      AND slug = ${slug}
      AND version = ${existing.version}
      AND id <> ${templateId}
    LIMIT 1
  `;
  if (slugConflict) return jsonError("procedure template slug already exists for this hive/version", 409);

  const [runCount] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pipeline_runs
    WHERE template_id = ${templateId}
  `;

  let normalizedSteps: { steps: NormalizedProcedureStep[] } | null = null;
  if (stepsProvided) {
    if (runCount.count > 0) {
      return jsonError("procedure template has run history; archive it and create a new version instead of replacing steps", 409);
    }
    const result = normalizeSteps(input.steps, active);
    if ("error" in result) return jsonError(result.error, 400);
    const missingRoles = await assertRolesExist(result.steps.map((step) => step.roleSlug));
    if (missingRoles) return jsonError(missingRoles, 400);
    normalizedSteps = result;
  } else if (active) {
    const [stepCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM pipeline_steps
      WHERE template_id = ${templateId}
    `;
    if (stepCount.count === 0) {
      return jsonError("at least one step is required when approving a procedure", 400);
    }
  }

  if (active) {
    const stepsForValidation = normalizedSteps?.steps ?? await loadStepsForValidation(templateId);
    const validationError = validateExecutionReadyProcedure({ finalOutputContract, steps: stepsForValidation });
    if (validationError) return jsonError(validationError, 400);
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE pipeline_templates
      SET slug = ${slug},
          name = ${name},
          department = ${department},
          description = ${description},
          mode = ${mode},
          default_sla_seconds = ${defaultSlaSeconds},
          max_total_cost_cents = ${maxTotalCostCents},
          final_output_contract = ${sql.json(finalOutputContract as unknown as Parameters<typeof sql.json>[0])},
          dashboard_visibility_policy = ${dashboardVisibilityPolicy},
          active = ${active},
          updated_at = NOW()
      WHERE id = ${templateId}
        AND hive_id = ${hiveId}
        AND scope = 'hive'
    `;
    if (normalizedSteps) {
      await tx`DELETE FROM pipeline_steps WHERE template_id = ${templateId}`;
      await insertProcedureSteps(tx, templateId, normalizedSteps.steps);
    }
  });

  const template = await loadTemplateForResponse(templateId);
  return jsonOk(template);
}

export async function DELETE(req: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const body = await parseJsonBody(req);
  if (!isRecord(body)) return jsonError("Invalid JSON body", 400);
  const input = body as ProcedureTemplateInput;
  const hiveId = stringValue(input.hiveId);
  const templateId = stringValue(input.templateId);
  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!templateId) return jsonError("templateId is required", 400);

  const denied = await requireHiveMutationAccess(authz.user, hiveId);
  if (denied) return denied;

  const existing = await loadTemplate(templateId, hiveId);
  if (!existing) return jsonError("procedure template not found", 404);

  const [runCount] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pipeline_runs
    WHERE template_id = ${templateId}
  `;

  if (runCount.count > 0) {
    await sql`
      UPDATE pipeline_templates
      SET active = false, updated_at = NOW()
      WHERE id = ${templateId}
        AND hive_id = ${hiveId}
        AND scope = 'hive'
    `;
    return jsonOk({
      templateId,
      deleted: false,
      archived: true,
      reason: "Procedure template has run history, so it was archived instead of hard deleted.",
    });
  }

  await sql`
    DELETE FROM pipeline_templates
    WHERE id = ${templateId}
      AND hive_id = ${hiveId}
      AND scope = 'hive'
  `;
  return jsonOk({ templateId, deleted: true, archived: false });
}

export async function POST(req: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const input = body as Partial<{
    hiveId: string;
    templateId: string;
    sourceTaskId: string;
    sourceContext: string;
    goalId: string;
    projectId: string;
    sprintNumber: number;
    selectionRationale: string;
    selection_rationale: string;
    confidence: number;
  }>;
  const hiveId = typeof input.hiveId === "string" ? input.hiveId.trim() : "";
  const templateId = typeof input.templateId === "string" ? input.templateId.trim() : "";
  const sourceTaskId = typeof input.sourceTaskId === "string" ? input.sourceTaskId.trim() : "";
  const suppliedSourceContext = typeof input.sourceContext === "string" ? input.sourceContext.trim() : "";
  const goalId = typeof input.goalId === "string" ? input.goalId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const sprintNumber = Number.isInteger(input.sprintNumber) && Number(input.sprintNumber) > 0 ? Number(input.sprintNumber) : null;
  const selectionRationale = typeof input.selectionRationale === "string" && input.selectionRationale.trim()
    ? input.selectionRationale.trim()
    : typeof input.selection_rationale === "string" && input.selection_rationale.trim()
      ? input.selection_rationale.trim()
      : "";
  const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence) ? input.confidence : null;

  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!templateId) return jsonError("templateId is required", 400);
  if (!sourceTaskId && !suppliedSourceContext) return jsonError("sourceTaskId or sourceContext is required", 400);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden", 403);
  }

  let goal: GoalRow | null = null;
  if (goalId) {
    const [goalRow] = await sql<GoalRow[]>`
      SELECT hive_id, project_id, session_id, title, description
      FROM goals
      WHERE id = ${goalId}
      LIMIT 1
    `;
    if (!goalRow || goalRow.hive_id !== hiveId) return jsonError("goalId does not belong to hive", 400);
    goal = goalRow;
    const callerSession = req.headers.get("x-supervisor-session")?.trim() ?? "";
    if (callerSession && goal.session_id && callerSession !== goal.session_id) {
      return jsonError("Forbidden: caller is not the supervisor session for this goal", 403);
    }
  }

  let sourceTask: SourceTaskRow | null = null;
  if (sourceTaskId) {
    const [sourceTaskRow] = await sql<SourceTaskRow[]>`
      SELECT id, title, brief
      FROM tasks
      WHERE id = ${sourceTaskId}
        AND hive_id = ${hiveId}
    `;
    if (!sourceTaskRow) {
      return jsonError(`sourceTaskId does not belong to hive: ${sourceTaskId}`, 400);
    }
    sourceTask = sourceTaskRow;
  }

  if (sourceTaskId) {
    const [activeExistingRun] = await sql<{ id: string }[]>`
      SELECT id
      FROM pipeline_runs
      WHERE hive_id = ${hiveId}
        AND source_task_id = ${sourceTaskId}
        AND status NOT IN ('complete', 'completed', 'failed', 'cancelled', 'canceled')
      LIMIT 1
    `;
    if (activeExistingRun) {
      return jsonError(`sourceTaskId already has an active pipeline run: ${activeExistingRun.id}`, 409);
    }
  }

  const sourceContext = suppliedSourceContext || (sourceTask ? [
    `Source task: ${sourceTask.title}`,
    sourceTask.brief,
  ].filter(Boolean).join("\n\n") : [
    goal ? `Goal: ${goal.title}` : null,
    goal?.description ?? null,
  ].filter(Boolean).join("\n\n"));

  const supervisorHandoff = selectionRationale
    ? [
      goalId ? `Supervisor selected this pipeline for goal ${goalId}${sprintNumber ? `, sprint ${sprintNumber}` : ""}.` : "Supervisor selected this pipeline.",
      `selection_rationale: ${selectionRationale}`,
      confidence === null ? null : `confidence: ${confidence}`,
    ].filter(Boolean).join("\n")
    : null;

  try {
    const result = await startPipelineRun(sql, {
      hiveId,
      templateId,
      sourceTaskId: sourceTaskId || undefined,
      sourceContext,
      goalId: goalId || undefined,
      projectId: projectId || goal?.project_id || undefined,
      sprintNumber: sprintNumber ?? undefined,
      supervisorHandoff: supervisorHandoff ?? undefined,
    });
    return jsonOk(result, 201);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to start pipeline run", 400);
  }
}
