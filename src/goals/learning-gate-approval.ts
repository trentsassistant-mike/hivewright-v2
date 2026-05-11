import type { Sql, TransactionSql } from "postgres";

export const LEARNING_GATE_FOLLOWUP_DECISION_KIND = "learning_gate_followup";

const REVIEW_INTERVAL_DAYS = 90;
const VALID_LEARNING_GATE_CATEGORIES = new Set([
  "template",
  "policy_candidate",
  "pipeline_candidate",
  "update_existing",
]);

type QuerySql = Sql | TransactionSql;

export type LearningGateApprovalDecision = {
  id: string;
  hive_id: string;
  goal_id: string | null;
  title: string;
  context: string;
  recommendation: string | null;
  options: unknown;
  kind: string;
  route_metadata?: unknown;
};

export type LearningGateApprovalResult =
  (
    | {
      status: "applied";
      category: string;
      assetType: "standing_instruction" | "pipeline_template";
      assetId: string;
    }
    | {
      status: "needs_detail";
      category: string;
      reason: string;
    }
    | {
      status: "review_note";
      category: string;
      reason: string;
    }
    | {
      status: "review_followup_created";
      category: string;
      followupDecisionId: string;
      followupDecisionKind: "learning_gate_followup_review";
      reason: string;
    }
    | {
      status: "not_applicable";
      reason: string;
    }
  ) & { appliedAt?: string };

type FollowupPayload = {
  category: string;
  action: string | null;
  rationale: string | null;
  summary: string | null;
  affectedDepartments: string[];
  pipeline: Record<string, unknown> | null;
};

type PipelineStepCandidate = {
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

type PipelineCandidate = {
  slug: string;
  name: string;
  department: string;
  description: string | null;
  finalOutputContract: Record<string, unknown>;
  steps: PipelineStepCandidate[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  return slug || "learning-gate-followup";
}

function compact(value: string | null | undefined, max = 1_500): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
}

function fallbackCategoryFromContext(context: string): string | null {
  const match = context.match(/Learning gate category:\s*([a-z_]+)/i);
  return match?.[1]?.trim() ?? null;
}

function metadataPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const direct = value.learningGateFollowup;
  if (isRecord(direct)) return direct;
  const snake = value.learning_gate_followup;
  if (isRecord(snake)) return snake;
  return null;
}

function existingApprovalResult(value: unknown): LearningGateApprovalResult | null {
  if (!isRecord(value) || !isRecord(value.learningGateApproval)) return null;
  const status = stringField(value.learningGateApproval, ["status"]);
  if (
    status !== "applied" &&
    status !== "needs_detail" &&
    status !== "review_note" &&
    status !== "review_followup_created" &&
    status !== "not_applicable"
  ) {
    return null;
  }
  return value.learningGateApproval as unknown as LearningGateApprovalResult;
}

function extractFollowupPayload(decision: LearningGateApprovalDecision): FollowupPayload | null {
  const metadata = metadataPayload(decision.route_metadata);
  const category = compact(
    (metadata ? stringField(metadata, ["category", "type"]) : null) ??
      fallbackCategoryFromContext(decision.context),
    100,
  );
  if (!category || !VALID_LEARNING_GATE_CATEGORIES.has(category)) return null;

  const action = compact(
    (metadata ? stringField(metadata, ["action", "content", "recommendation"]) : null) ??
      decision.recommendation,
  );
  const rationale = compact(metadata ? stringField(metadata, ["rationale"]) : null, 700);
  const summary = compact(metadata ? stringField(metadata, ["summary"]) : null, 700);
  const affectedDepartments = metadata
    ? arrayOfStrings(metadata.affectedDepartments ?? metadata.affected_departments)
    : [];
  const pipeline = metadata && isRecord(metadata.pipeline)
    ? metadata.pipeline
    : metadata && isRecord(metadata.pipelineCandidate)
      ? metadata.pipelineCandidate
      : null;

  return { category, action, rationale, summary, affectedDepartments, pipeline };
}

async function stampDecisionApproval(
  sql: QuerySql,
  decisionId: string,
  result: LearningGateApprovalResult,
): Promise<void> {
  if (result.status === "not_applicable") return;
  await sql`
    UPDATE decisions
    SET route_metadata = COALESCE(route_metadata, '{}'::jsonb) ||
      ${sql.json({
        learningGateApproval: {
          ...result,
          appliedAt: new Date().toISOString(),
        },
      })}::jsonb
    WHERE id = ${decisionId}
  `;
}

async function applyPolicyCandidate(
  sql: QuerySql,
  decision: LearningGateApprovalDecision,
  payload: FollowupPayload,
): Promise<LearningGateApprovalResult> {
  const content = compact(payload.action ?? decision.recommendation);
  if (!content) {
    return {
      status: "needs_detail",
      category: payload.category,
      reason: "Policy candidate approval needs explicit instruction content before creating a governed policy.",
    };
  }

  const reviewAt = new Date();
  reviewAt.setDate(reviewAt.getDate() + REVIEW_INTERVAL_DAYS);

  const [instruction] = await sql`
    INSERT INTO standing_instructions (
      hive_id,
      content,
      affected_departments,
      confidence,
      review_at
    ) VALUES (
      ${decision.hive_id},
      ${content},
      ${sql.json(payload.affectedDepartments)},
      1.0,
      ${reviewAt}
    )
    RETURNING id
  `;

  return {
    status: "applied",
    category: payload.category,
    assetType: "standing_instruction",
    assetId: instruction.id as string,
  };
}

function normalizePipelineStep(value: unknown, index: number): PipelineStepCandidate | null {
  if (!isRecord(value)) return null;
  const name = stringField(value, ["name", "title"]);
  const duty = stringField(value, ["duty", "brief", "description"]);
  if (!name || !duty) return null;

  const outputContract = isRecord(value.outputContract)
    ? value.outputContract
    : isRecord(value.output_contract)
      ? value.output_contract
      : { requiredFields: ["summary", "evidence"] };
  const acceptanceCriteria = stringField(value, ["acceptanceCriteria", "acceptance_criteria"]) ??
    "Step output satisfies the duty and cites evidence.";

  return {
    slug: slugify(stringField(value, ["slug"]) ?? name),
    name,
    roleSlug: stringField(value, ["roleSlug", "role_slug", "assignedTo", "assigned_to"]) ?? "goal-supervisor",
    duty,
    qaRequired: booleanField(value, "qaRequired", booleanField(value, "qa_required", false)),
    maxRuntimeSeconds: Math.max(1, numberField(value, "maxRuntimeSeconds", numberField(value, "max_runtime_seconds", 300))),
    maxRetries: Math.min(3, Math.max(0, numberField(value, "maxRetries", numberField(value, "max_retries", 1)))),
    maxCostCents: typeof value.maxCostCents === "number" && Number.isFinite(value.maxCostCents)
      ? value.maxCostCents
      : typeof value.max_cost_cents === "number" && Number.isFinite(value.max_cost_cents)
        ? value.max_cost_cents
        : null,
    outputContract,
    acceptanceCriteria,
    failurePolicy: stringField(value, ["failurePolicy", "failure_policy"]) ?? "ask_owner",
    driftCheck: isRecord(value.driftCheck)
      ? value.driftCheck
      : isRecord(value.drift_check)
        ? value.drift_check
        : { mode: "source_similarity", threshold: 0.3 },
  };
}

function normalizePipelineCandidate(payload: FollowupPayload): PipelineCandidate | null {
  const pipeline = payload.pipeline;
  if (!pipeline) return null;
  const stepsInput = Array.isArray(pipeline.steps) ? pipeline.steps : [];
  const steps = stepsInput
    .map(normalizePipelineStep)
    .filter((step): step is PipelineStepCandidate => step !== null);
  if (steps.length === 0 || steps.length !== stepsInput.length) return null;

  const name = stringField(pipeline, ["name", "title"]) ??
    compact(payload.action, 120) ??
    "Learning Gate Pipeline";
  const finalOutputContract = isRecord(pipeline.finalOutputContract)
    ? pipeline.finalOutputContract
    : isRecord(pipeline.final_output_contract)
      ? pipeline.final_output_contract
      : { requiredFields: ["summary", "evidence", "verdict"] };

  return {
    slug: slugify(stringField(pipeline, ["slug"]) ?? name),
    name,
    department: stringField(pipeline, ["department"]) ?? "operations",
    description: stringField(pipeline, ["description"]) ?? payload.rationale ?? payload.summary,
    finalOutputContract,
    steps,
  };
}

async function missingPipelineRoleSlugs(
  sql: QuerySql,
  candidate: PipelineCandidate,
): Promise<string[]> {
  const roleSlugs = Array.from(new Set(candidate.steps.map((step) => step.roleSlug)));
  if (roleSlugs.length === 0) return [];

  const existing = await sql<{ slug: string }[]>`
    SELECT slug
    FROM role_templates
    WHERE slug = ANY(${roleSlugs}::varchar[])
  `;
  const existingSlugs = new Set(existing.map((row) => row.slug));
  return roleSlugs.filter((slug) => !existingSlugs.has(slug));
}

async function applyPipelineCandidate(
  sql: QuerySql,
  decision: LearningGateApprovalDecision,
  payload: FollowupPayload,
): Promise<LearningGateApprovalResult> {
  const candidate = normalizePipelineCandidate(payload);
  if (!candidate) {
    return {
      status: "needs_detail",
      category: payload.category,
      reason: "Pipeline candidate approval needs structured pipeline steps before creating an active governed template.",
    };
  }

  const missingRoles = await missingPipelineRoleSlugs(sql, candidate);
  if (missingRoles.length > 0) {
    return {
      status: "needs_detail",
      category: payload.category,
      reason: `Pipeline candidate approval references unknown role slug(s): ${missingRoles.join(", ")}.`,
    };
  }

  const [versionRow] = await sql<{ version: number }[]>`
    SELECT COALESCE(MAX(version), 0)::int + 1 AS version
    FROM pipeline_templates
    WHERE scope = 'hive'
      AND hive_id = ${decision.hive_id}
      AND slug = ${candidate.slug}
  `;
  const [template] = await sql`
    INSERT INTO pipeline_templates (
      scope,
      hive_id,
      slug,
      name,
      department,
      description,
      mode,
      final_output_contract,
      dashboard_visibility_policy,
      version,
      active
    ) VALUES (
      'hive',
      ${decision.hive_id},
      ${candidate.slug},
      ${candidate.name},
      ${candidate.department},
      ${candidate.description},
      'production',
      ${sql.json(candidate.finalOutputContract as unknown as Parameters<typeof sql.json>[0])},
      'summary_artifacts_only',
      ${versionRow.version},
      true
    )
    RETURNING id
  `;

  for (const [index, step] of candidate.steps.entries()) {
    await sql`
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
        ${template.id},
        ${index + 1},
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

  return {
    status: "applied",
    category: payload.category,
    assetType: "pipeline_template",
    assetId: template.id as string,
  };
}

async function createUpdateExistingReviewFollowup(
  sql: QuerySql,
  decision: LearningGateApprovalDecision,
  payload: FollowupPayload,
): Promise<LearningGateApprovalResult> {
  const context = [
    "A learning-gate update_existing candidate was approved by the owner.",
    "Existing governed assets were not changed automatically.",
    "",
    `Source decision: ${decision.id}`,
    decision.goal_id ? `Goal: ${decision.goal_id}` : null,
    payload.action ? `Requested update: ${payload.action}` : null,
    payload.rationale ? `Rationale: ${payload.rationale}` : null,
    payload.summary ? `Completion summary: ${payload.summary}` : null,
    "",
    "Review the existing governed asset, propose the precise patch, and route it through the asset's normal approval/update path.",
  ].filter((line): line is string => line !== null).join("\n");

  const [followup] = await sql`
    INSERT INTO decisions (
      hive_id,
      goal_id,
      title,
      context,
      recommendation,
      options,
      priority,
      status,
      kind,
      route_metadata
    ) VALUES (
      ${decision.hive_id},
      ${decision.goal_id},
      'Review approved learning-gate update to existing governed asset',
      ${context},
      ${payload.action ?? "Review the approved update_existing learning-gate recommendation."},
      ${sql.json([
        {
          key: "review-update",
          label: "Review update",
          response: "discussed",
          consequence: "Keeps this follow-up open while the precise governed asset update is prepared.",
        },
        {
          key: "dismiss-update",
          label: "Dismiss update",
          response: "rejected",
          consequence: "Leaves existing governed assets unchanged.",
        },
      ])},
      'normal',
      'pending',
      'learning_gate_followup_review',
      ${sql.json({
        learningGateFollowupReview: {
          sourceDecisionId: decision.id,
          category: payload.category,
          action: payload.action,
          rationale: payload.rationale,
        },
      })}
    )
    RETURNING id
  `;

  return {
    status: "review_followup_created",
    category: payload.category,
    followupDecisionId: followup.id as string,
    followupDecisionKind: "learning_gate_followup_review",
    reason: "Existing governed assets were not mutated automatically; a separate review/update follow-up was created.",
  };
}

function approvedTemplateNoteResult(payload: FollowupPayload): LearningGateApprovalResult {
  return {
    status: "review_note",
    category: payload.category,
    reason: "Approved learning-gate template recommendation recorded for review; no reusable non-mandatory template store is available on this path.",
  };
}

export async function applyApprovedLearningGateFollowup(
  sql: QuerySql,
  decision: LearningGateApprovalDecision,
): Promise<LearningGateApprovalResult> {
  if (decision.kind !== LEARNING_GATE_FOLLOWUP_DECISION_KIND) {
    return { status: "not_applicable", reason: "Decision is not a learning-gate follow-up." };
  }

  const existingApproval = existingApprovalResult(decision.route_metadata);
  if (existingApproval) return existingApproval;

  const payload = extractFollowupPayload(decision);
  if (!payload) {
    const result: LearningGateApprovalResult = {
      status: "needs_detail",
      category: "unknown",
      reason: "Learning-gate follow-up decision did not include a supported category.",
    };
    await stampDecisionApproval(sql, decision.id, result);
    return result;
  }

  const result = payload.category === "policy_candidate"
    ? await applyPolicyCandidate(sql, decision, payload)
    : payload.category === "pipeline_candidate"
      ? await applyPipelineCandidate(sql, decision, payload)
      : payload.category === "update_existing"
        ? await createUpdateExistingReviewFollowup(sql, decision, payload)
        : approvedTemplateNoteResult(payload);

  await stampDecisionApproval(sql, decision.id, result);
  return result;
}
