import type { Sql, TransactionSql } from "postgres";

export type StartPipelineRunInput = {
  hiveId: string;
  templateId: string;
  sourceContext: string;
  sourceTaskId?: string;
  goalId?: string;
  projectId?: string;
  sprintNumber?: number;
  supervisorHandoff?: string;
};

export type StartPipelineRunResult = {
  runId: string;
  stepRunId: string;
  taskId: string;
};

export type AdvancePipelineRunInput = {
  taskId: string;
  resultSummary: string;
  supervisorHandoff?: string;
};

export type AdvancePipelineRunResult =
  | { status: "advanced"; runId: string; stepRunId: string; taskId: string }
  | { status: "completed"; runId: string }
  | { status: "not_pipeline_task" };

type PipelineStepRow = {
  id: string;
  template_id: string;
  step_order: number;
  slug: string;
  name: string;
  role_slug: string;
  duty: string;
  qa_required: boolean;
  max_runtime_seconds: number;
  max_retries: number;
  max_cost_cents: number | null;
  output_contract: Record<string, unknown>;
  acceptance_criteria: string | null;
  failure_policy: string;
  drift_check: Record<string, unknown>;
};

type PipelineTemplateRow = {
  id: string;
  version: number;
  default_sla_seconds: number;
  final_output_contract: Record<string, unknown>;
  dashboard_visibility_policy: string;
};

type PipelineStepRunRow = {
  id: string;
  run_id: string;
  step_id: string;
};

type PipelineRunRow = {
  id: string;
  hive_id: string;
  template_id: string;
  status: string;
  source_task_id: string | null;
  goal_id: string | null;
  project_id: string | null;
};

type QuerySql = Sql | TransactionSql;


export type PipelineTaskExecutionRules = {
  runId: string;
  stepRunId: string;
  stepId: string;
  maxRuntimeSeconds: number;
  maxRetries: number;
  maxCostCents: number | null;
  outputContract: Record<string, unknown>;
  failurePolicy: string;
  driftCheck: Record<string, unknown>;
  sourceContext: string;
};

export type PipelineOutputValidationResult = {
  valid: boolean;
  missingFields: string[];
  invalidFields: string[];
  driftIssues: string[];
};

type PipelineJsonSchema = {
  type?: string;
  required?: unknown;
  properties?: Record<string, PipelineJsonSchema>;
  items?: PipelineJsonSchema;
  enum?: unknown;
};

function requiredFieldsFromContract(contract: Record<string, unknown> | null | undefined): string[] {
  const requiredFields = contract?.requiredFields;
  if (!Array.isArray(requiredFields)) return [];
  return requiredFields
    .filter((field): field is string => typeof field === "string")
    .map((field) => field.trim())
    .filter(Boolean);
}

function outputMentionsRequiredField(output: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const label = `("${escaped}"|${escaped})`;
  return [
    // Plain labels: summary: ..., verification = ..., { "summary": ... }
    new RegExp(`(^|[\n\r,{])\\s*${label}\\s*[:=-]`, "i"),
    // Markdown headings: ## Summary, **summary**, - **Verification**: ...
    new RegExp(`(^|[\n\r])\\s*(#{1,6}\\s*)?(?:[-*]\\s*)?(\\*\\*|__)?${escaped}(\\*\\*|__)?\\s*(:|-)?\\s*(?=[\n\r]|\\S)`, "i"),
  ].some((pattern) => pattern.test(output));
}

function schemaFromContract(contract: Record<string, unknown> | null | undefined): PipelineJsonSchema | null {
  const schema = contract?.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  return schema as PipelineJsonSchema;
}

function parseJsonObjectOutput(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateSchemaValue(path: string, value: unknown, schema: PipelineJsonSchema): string[] {
  const issues: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push(`${path}: expected one of ${schema.enum.map(String).join(", ")}`);
    return issues;
  }

  if (schema.type && jsonType(value) !== schema.type) {
    issues.push(`${path}: expected ${schema.type}`);
    return issues;
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      issues.push(...validateSchemaValue(`${path}[${index}]`, item, schema.items as PipelineJsonSchema));
    });
  }

  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [];
    for (const field of required) {
      if (!(field in objectValue)) issues.push(`${path}.${field}: required`);
    }
    if (schema.properties) {
      for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        if (field in objectValue) issues.push(...validateSchemaValue(field, objectValue[field], fieldSchema));
      }
    }
  }

  return issues;
}

type PipelineOutputValidationOptions = {
  sourceContext?: string | null;
  driftCheck?: Record<string, unknown> | null;
};

function tokenizeForSimilarity(text: string): Set<string> {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "about", "must", "should", "will", "have", "has",
    "been", "were", "are", "was", "you", "your", "our", "out", "put", "task", "source", "context", "write",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !stopWords.has(token)),
  );
}

function sourceSimilarity(sourceContext: string, output: string): number {
  const sourceTokens = tokenizeForSimilarity(sourceContext);
  if (sourceTokens.size === 0) return 1;
  const outputTokens = tokenizeForSimilarity(output);
  let overlap = 0;
  sourceTokens.forEach((token) => {
    if (outputTokens.has(token)) overlap += 1;
  });
  return overlap / sourceTokens.size;
}

function validateOutputDrift(output: string, options?: PipelineOutputValidationOptions): string[] {
  const driftCheck = options?.driftCheck;
  const mode = typeof driftCheck?.mode === "string" ? driftCheck.mode : null;
  if (mode !== "source_similarity") return [];

  const sourceContext = options?.sourceContext?.trim();
  if (!sourceContext) return [];

  const threshold = typeof driftCheck?.threshold === "number" && Number.isFinite(driftCheck.threshold)
    ? driftCheck.threshold
    : 0.3;
  const similarity = sourceSimilarity(sourceContext, output);
  if (similarity >= threshold) return [];
  return [`output drifted from source intent: source similarity below ${threshold}`];
}

export function validatePipelineOutputContract(
  output: string,
  contract: Record<string, unknown> | null | undefined,
  options?: PipelineOutputValidationOptions,
): PipelineOutputValidationResult {
  const requiredFields = requiredFieldsFromContract(contract);
  const schema = schemaFromContract(contract);
  const driftIssues = validateOutputDrift(output, options);
  if (schema) {
    const parsed = parseJsonObjectOutput(output);
    if (!parsed) {
      return {
        valid: false,
        missingFields: requiredFields,
        invalidFields: ["output: expected JSON object matching contract schema"],
        driftIssues,
      };
    }
    const schemaRequired = Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [];
    const required = Array.from(new Set([...requiredFields, ...schemaRequired]));
    const missingFields = required.filter((field) => !(field in parsed));
    const invalidFields = schema.properties
      ? Object.entries(schema.properties).flatMap(([field, fieldSchema]) => (field in parsed ? validateSchemaValue(field, parsed[field], fieldSchema) : []))
      : validateSchemaValue("output", parsed, schema);
    return { valid: missingFields.length === 0 && invalidFields.length === 0 && driftIssues.length === 0, missingFields, invalidFields, driftIssues };
  }

  const missingFields = requiredFields.filter((field) => !outputMentionsRequiredField(output, field));
  return { valid: missingFields.length === 0 && driftIssues.length === 0, missingFields, invalidFields: [], driftIssues };
}

export async function getPipelineTaskExecutionRules(
  sql: QuerySql,
  taskId: string,
): Promise<PipelineTaskExecutionRules | null> {
  const [row] = await sql<PipelineTaskExecutionRules[]>`
    SELECT
      psr.run_id AS "runId",
      psr.id AS "stepRunId",
      ps.id AS "stepId",
      ps.max_runtime_seconds AS "maxRuntimeSeconds",
      ps.max_retries AS "maxRetries",
      ps.max_cost_cents AS "maxCostCents",
      ps.output_contract AS "outputContract",
      ps.failure_policy AS "failurePolicy",
      ps.drift_check AS "driftCheck",
      COALESCE(
        CONCAT('Source task: ', source_task.title, E'\n\n', COALESCE(source_task.brief, '')),
        CONCAT('Pipeline run ', pr.id)
      ) AS "sourceContext"
    FROM pipeline_step_runs psr
    JOIN pipeline_steps ps ON ps.id = psr.step_id
    JOIN pipeline_runs pr ON pr.id = psr.run_id
    LEFT JOIN tasks source_task ON source_task.id = pr.source_task_id AND source_task.hive_id = pr.hive_id
    WHERE psr.task_id = ${taskId}
      AND pr.status = 'active'
    LIMIT 1
  `;
  if (!row) return null;
  return row;
}

export async function markPipelineTaskRunning(sql: QuerySql, taskId: string): Promise<void> {
  await sql`
    UPDATE pipeline_step_runs
    SET status = 'running', updated_at = NOW()
    WHERE task_id = ${taskId}
      AND status = 'pending'
  `;
}

export async function failPipelineRunFromTask(
  sql: Sql,
  input: { taskId: string; reason: string },
): Promise<{ status: "failed"; runId: string } | { status: "not_pipeline_task" }> {
  const [stepRun] = await sql<{ id: string; run_id: string }[]>`
    SELECT id, run_id
    FROM pipeline_step_runs
    WHERE task_id = ${input.taskId}
    LIMIT 1
  `;
  if (!stepRun) return { status: "not_pipeline_task" };

  await sql.begin(async (tx) => {
    await tx`
      UPDATE pipeline_step_runs
      SET status = 'failed', result_summary = ${input.reason}, completed_at = NOW(), updated_at = NOW()
      WHERE id = ${stepRun.id}
    `;
    await tx`
      UPDATE pipeline_runs
      SET status = 'failed', supervisor_handoff = ${input.reason}, completed_at = NOW(), updated_at = NOW()
      WHERE id = ${stepRun.run_id}
        AND status = 'active'
    `;
    await tx`
      UPDATE tasks
      SET status = 'failed', failure_reason = ${input.reason}, updated_at = NOW()
      WHERE id = ${input.taskId}
    `;
  });

  return { status: "failed", runId: stepRun.run_id };
}

export type PipelineValidationIssue = {
  code: string;
  message: string;
  stepId?: string;
};

export type PipelineValidationResult = {
  valid: boolean;
  issues: PipelineValidationIssue[];
};

function hasRequiredFieldsContract(contract: Record<string, unknown> | null | undefined) {
  const requiredFields = requiredFieldsFromContract(contract);
  return requiredFields.length > 0;
}

function validateStepRules(step: PipelineStepRow): PipelineValidationIssue[] {
  const issues: PipelineValidationIssue[] = [];
  if (!Number.isFinite(step.max_runtime_seconds) || step.max_runtime_seconds <= 0) {
    issues.push({ code: "step.max_runtime_seconds", message: "Step must have a positive max runtime.", stepId: step.id });
  }
  if (!Number.isFinite(step.max_retries) || step.max_retries < 0 || step.max_retries > 3) {
    issues.push({ code: "step.max_retries", message: "Step retries must be between 0 and 3.", stepId: step.id });
  }
  if (!hasRequiredFieldsContract(step.output_contract)) {
    issues.push({ code: "step.output_contract", message: "Step must define an output contract with requiredFields.", stepId: step.id });
  }
  if (!step.acceptance_criteria?.trim()) {
    issues.push({ code: "step.acceptance_criteria", message: "Step must define acceptance criteria.", stepId: step.id });
  }
  if (!step.failure_policy?.trim()) {
    issues.push({ code: "step.failure_policy", message: "Step must define a failure policy.", stepId: step.id });
  }
  const driftMode = step.drift_check?.mode;
  if (typeof driftMode !== "string" || driftMode.trim().length === 0) {
    issues.push({ code: "step.drift_check", message: "Step must define a drift-check mode.", stepId: step.id });
  }
  return issues;
}

function summarizePreviousStepResult(previousResult: string) {
  const cleaned = previousResult.trim();
  const verdictIndex = cleaned.toLowerCase().lastIndexOf("\n\npass\n\n");
  const artifactIndex = Math.max(
    cleaned.lastIndexOf("Wrote "),
    cleaned.lastIndexOf("Created "),
    cleaned.lastIndexOf("Verification:"),
  );
  const startIndex = Math.max(verdictIndex > -1 ? verdictIndex + 2 : -1, artifactIndex);
  const focused = startIndex > -1 ? cleaned.slice(startIndex).trim() : cleaned;

  if (focused.length <= 1800) return focused;
  return `${focused.slice(0, 1800).trim()}\n\n[Previous result truncated for pipeline handoff clarity.]`;
}

function buildStepTaskBrief(params: {
  step: PipelineStepRow;
  sourceContext: string;
  previousResult?: string;
}) {
  const parts = [
    `Pipeline step: ${params.step.name}`,
    `Step duty:\n${params.step.duty}`,
    `Source context:\n${params.sourceContext}`,
  ];

  if (params.previousResult) {
    parts.push(`Previous step result:\n${summarizePreviousStepResult(params.previousResult)}`);
  }

  const executionRules = [
    `Execution bounds: max runtime ${params.step.max_runtime_seconds}s; max retries ${params.step.max_retries}`,
    params.step.max_cost_cents === null ? null : `Max cost: ${params.step.max_cost_cents} cents`,
    `Failure policy: ${params.step.failure_policy}`,
    `Output contract required fields: ${requiredFieldsFromContract(params.step.output_contract).join(", ")}`,
    `Return those required fields as explicit labels, e.g. ${requiredFieldsFromContract(params.step.output_contract).map((field) => `${field}: ...`).join("; ")}`,
    params.step.acceptance_criteria ? `Acceptance criteria:
${params.step.acceptance_criteria}` : null,
    `Drift check: stay anchored to the original source task; if the requested output no longer matches source intent, fail/ask owner instead of continuing.`,
  ].filter(Boolean) as string[];

  parts.push(executionRules.join("\n"));

  return parts.join("\n\n");
}

async function getOrderedSteps(sql: QuerySql, templateId: string): Promise<PipelineStepRow[]> {
  return sql<PipelineStepRow[]>`
    SELECT
      id,
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
    FROM pipeline_steps
    WHERE template_id = ${templateId}
    ORDER BY step_order ASC
  `;
}

async function assertOptionalReferencesBelongToHive(sql: QuerySql, input: {
  hiveId: string;
  sourceTaskId?: string | null;
  goalId?: string | null;
  projectId?: string | null;
}) {
  if (input.sourceTaskId) {
    const [task] = await sql<{ id: string }[]>`
      SELECT id FROM tasks WHERE id = ${input.sourceTaskId} AND hive_id = ${input.hiveId}
    `;
    if (!task) throw new Error(`sourceTaskId does not belong to hive: ${input.sourceTaskId}`);
  }

  if (input.goalId) {
    const [goal] = await sql<{ id: string }[]>`
      SELECT id FROM goals WHERE id = ${input.goalId} AND hive_id = ${input.hiveId}
    `;
    if (!goal) throw new Error(`goalId does not belong to hive: ${input.goalId}`);
  }

  if (input.projectId) {
    const [project] = await sql<{ id: string }[]>`
      SELECT id FROM projects WHERE id = ${input.projectId} AND hive_id = ${input.hiveId}
    `;
    if (!project) throw new Error(`projectId does not belong to hive: ${input.projectId}`);
  }
}

async function getPipelineSourceContext(sql: QuerySql, run: PipelineRunRow): Promise<string> {
  if (!run.source_task_id) return `Pipeline run ${run.id}`;

  const [sourceTask] = await sql<{ title: string; brief: string | null }[]>`
    SELECT title, brief
    FROM tasks
    WHERE id = ${run.source_task_id}
      AND hive_id = ${run.hive_id}
    LIMIT 1
  `;

  if (!sourceTask) return `Pipeline run ${run.id}\nSource task: ${run.source_task_id}`;
  return `Source task: ${sourceTask.title}\n\n${sourceTask.brief ?? ""}`.trim();
}

export function validatePipelineDefinition(
  template: PipelineTemplateRow,
  steps: PipelineStepRow[],
): PipelineValidationResult {
  const issues: PipelineValidationIssue[] = [];
  if (!Number.isFinite(template.default_sla_seconds) || template.default_sla_seconds <= 0) {
    issues.push({ code: "template.default_sla_seconds", message: "Template must have a positive default SLA." });
  }
  if (!hasRequiredFieldsContract(template.final_output_contract)) {
    issues.push({ code: "template.final_output_contract", message: "Template must define a final output contract with requiredFields." });
  }
  if (template.dashboard_visibility_policy !== "summary_artifacts_only" && template.dashboard_visibility_policy !== "artifact_only" && template.dashboard_visibility_policy !== "debug_full_transcript") {
    issues.push({ code: "template.dashboard_visibility_policy", message: "Template must define a valid dashboard visibility policy." });
  }
  if (steps.length === 0) {
    issues.push({ code: "template.steps", message: "Template must have at least one step." });
  }
  for (const step of steps) issues.push(...validateStepRules(step));
  return { valid: issues.length === 0, issues };
}

export async function startPipelineRun(
  sql: Sql,
  input: StartPipelineRunInput,
): Promise<StartPipelineRunResult> {
  return sql.begin(async (tx) => {
    await assertOptionalReferencesBelongToHive(tx, input);

    const [template] = await tx<PipelineTemplateRow[]>`
      SELECT id, version, default_sla_seconds, final_output_contract, dashboard_visibility_policy
      FROM pipeline_templates
      WHERE id = ${input.templateId}
        AND active = true
        AND (scope = 'global' OR hive_id = ${input.hiveId})
    `;

    if (!template) {
      throw new Error(`Pipeline template not found or inactive: ${input.templateId}`);
    }

    const steps = await getOrderedSteps(tx, template.id);
    const validation = validatePipelineDefinition(template, steps);
    if (!validation.valid) {
      throw new Error(`Pipeline template failed validation: ${validation.issues.map((issue) => issue.code).join(", ")}`);
    }
    const firstStep = steps[0];

    if (!firstStep) {
      throw new Error(`Pipeline template has no steps: ${input.templateId}`);
    }

    const [run] = await tx<{ id: string }[]>`
      INSERT INTO pipeline_runs (
        hive_id,
        template_id,
        template_version,
        status,
        current_step_id,
        source_task_id,
        goal_id,
        project_id,
        supervisor_handoff
      )
      VALUES (
        ${input.hiveId},
        ${template.id},
        ${template.version},
        'active',
        ${firstStep.id},
        ${input.sourceTaskId ?? null},
        ${input.goalId ?? null},
        ${input.projectId ?? null},
        ${input.supervisorHandoff ?? null}
      )
      RETURNING id
    `;

    const [task] = await tx<{ id: string }[]>`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        priority,
        title,
        brief,
        parent_task_id,
        goal_id,
        project_id,
        qa_required,
        sprint_number
      )
      VALUES (
        ${input.hiveId},
        ${firstStep.role_slug},
        'pipeline',
        'pending',
        5,
        ${`Pipeline: ${firstStep.name}`},
        ${buildStepTaskBrief({ step: firstStep, sourceContext: input.sourceContext })},
        ${input.sourceTaskId ?? null},
        ${input.goalId ?? null},
        ${input.projectId ?? null},
        ${firstStep.qa_required},
        ${input.sprintNumber ?? null}
      )
      RETURNING id
    `;

    const [stepRun] = await tx<{ id: string }[]>`
      INSERT INTO pipeline_step_runs (run_id, step_id, task_id, status)
      VALUES (${run.id}, ${firstStep.id}, ${task.id}, 'pending')
      RETURNING id
    `;

    return { runId: run.id, stepRunId: stepRun.id, taskId: task.id };
  });
}

export async function advancePipelineRunFromTask(
  sql: Sql,
  input: AdvancePipelineRunInput,
): Promise<AdvancePipelineRunResult> {
  return sql.begin(async (tx) => {
    const [stepRun] = await tx<PipelineStepRunRow[]>`
      SELECT id, run_id, step_id
      FROM pipeline_step_runs
      WHERE task_id = ${input.taskId}
      FOR UPDATE
    `;

    if (!stepRun) {
      return { status: "not_pipeline_task" };
    }

    const [run] = await tx<PipelineRunRow[]>`
      SELECT id, hive_id, template_id, status, source_task_id, goal_id, project_id
      FROM pipeline_runs
      WHERE id = ${stepRun.run_id}
      FOR UPDATE
    `;

    if (!run || run.status !== "active") {
      throw new Error(`Pipeline run is not active for task: ${input.taskId}`);
    }

    await assertOptionalReferencesBelongToHive(tx, {
      hiveId: run.hive_id,
      sourceTaskId: run.source_task_id,
      goalId: run.goal_id,
      projectId: run.project_id,
    });

    const steps = await getOrderedSteps(tx, run.template_id);
    const currentIndex = steps.findIndex((step) => step.id === stepRun.step_id);

    if (currentIndex === -1) {
      throw new Error(`Pipeline step not found in run template: ${stepRun.step_id}`);
    }

    await tx`
      UPDATE pipeline_step_runs
      SET status = 'complete',
          result_summary = ${input.resultSummary},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${stepRun.id}
    `;

    await tx`
      UPDATE tasks
      SET status = 'completed',
          result_summary = ${input.resultSummary},
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW()
      WHERE id = ${input.taskId}
        AND hive_id = ${run.hive_id}
    `;

    const nextStep = steps[currentIndex + 1];
    const sourceContext = await getPipelineSourceContext(tx, run);

    if (!nextStep) {
      await tx`
        UPDATE pipeline_runs
        SET status = 'complete',
            current_step_id = NULL,
            supervisor_handoff = ${input.supervisorHandoff ?? input.resultSummary},
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${run.id}
      `;

      return { status: "completed", runId: run.id };
    }

    const [nextTask] = await tx<{ id: string }[]>`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        priority,
        title,
        brief,
        parent_task_id,
        goal_id,
        project_id,
        qa_required,
        sprint_number
      )
      VALUES (
        ${run.hive_id},
        ${nextStep.role_slug},
        'pipeline',
        'pending',
        5,
        ${`Pipeline: ${nextStep.name}`},
        ${buildStepTaskBrief({
          step: nextStep,
          sourceContext,
          previousResult: input.resultSummary,
        })},
        ${input.taskId},
        ${run.goal_id},
        ${run.project_id},
        ${nextStep.qa_required},
        (SELECT sprint_number FROM tasks WHERE id = ${input.taskId})
      )
      RETURNING id
    `;

    const [nextStepRun] = await tx<{ id: string }[]>`
      INSERT INTO pipeline_step_runs (run_id, step_id, task_id, status)
      VALUES (${run.id}, ${nextStep.id}, ${nextTask.id}, 'pending')
      RETURNING id
    `;

    await tx`
      UPDATE pipeline_runs
      SET current_step_id = ${nextStep.id},
          updated_at = NOW()
      WHERE id = ${run.id}
    `;

    return {
      status: "advanced",
      runId: run.id,
      stepRunId: nextStepRun.id,
      taskId: nextTask.id,
    };
  });
}
