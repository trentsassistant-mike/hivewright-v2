import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { readLatestCodexEmptyOutputDiagnostic } from "@/runtime-diagnostics/codex-empty-output";
import { readLatestTaskContextProvenance } from "@/provenance/task-context";
import { serializeGoalBudgetStatus } from "@/budget/status";
import { toPublicUsageSummary } from "@/usage/billable-usage";

type TaskRow = {
  id: string;
  hive_id: string;
  assigned_to: string;
  created_by: string;
  status: string;
  priority: number;
  title: string;
  brief: string;
  parent_task_id: string | null;
  goal_id: string | null;
  project_id: string | null;
  sprint_number: number | null;
  qa_required: boolean;
  acceptance_criteria: string | null;
  result_summary: string | null;
  retry_count: number;
  doctor_attempts: number;
  failure_reason: string | null;
  fresh_input_tokens: number | null;
  cached_input_tokens: number | null;
  cached_input_tokens_known: boolean;
  total_context_tokens: number | null;
  estimated_billable_cost_cents: number | null;
  usage_details: unknown;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_cents: number | null;
  model_used: string | null;
  goal_budget_cents: number | null;
  goal_spent_cents: number | null;
  goal_budget_state: "ok" | "warning" | "paused" | "hard_stopped" | null;
  goal_budget_warning_triggered_at: Date | null;
  goal_budget_enforced_at: Date | null;
  goal_budget_enforcement_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type WorkProductRow = {
  id: string;
  content: string;
  summary: string | null;
  artifact_kind: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  model_name: string | null;
  model_snapshot: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  usage_details: unknown;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

function mapWorkProductRow(r: WorkProductRow) {
  const isImage = r.artifact_kind === "image" && (r.mime_type === "image/png" || r.mime_type === "image/jpeg");
  return {
    id: r.id,
    content: r.content,
    summary: r.summary,
    artifactKind: r.artifact_kind,
    mimeType: r.mime_type,
    dimensions: r.width !== null && r.height !== null
      ? { width: r.width, height: r.height }
      : null,
    model: {
      name: r.model_name,
      snapshot: r.model_snapshot,
    },
    usage: toPublicUsageSummary({
      usageDetails: r.usage_details,
      tokensInput: r.prompt_tokens,
      tokensOutput: r.output_tokens,
      costCents: r.cost_cents,
    }),
    metadata: r.metadata,
    downloadUrl: isImage ? `/api/work-products/${r.id}/download` : null,
    createdAt: r.created_at,
  };
}

function mapTaskRow(r: TaskRow, workProducts: WorkProductRow[] = []) {
  const goalBudget = r.goal_budget_cents !== null || r.goal_spent_cents !== null
    ? serializeGoalBudgetStatus({
      budgetCents: r.goal_budget_cents,
      spentCents: r.goal_spent_cents,
      budgetState: r.goal_budget_state,
      warningTriggeredAt: r.goal_budget_warning_triggered_at,
      enforcedAt: r.goal_budget_enforced_at,
      reason: r.goal_budget_enforcement_reason,
      updatedAt: r.updated_at,
    })
    : null;
  return {
    id: r.id,
    hiveId: r.hive_id,
    assignedTo: r.assigned_to,
    createdBy: r.created_by,
    status: r.status,
    priority: r.priority,
    title: r.title,
    brief: r.brief,
    parentTaskId: r.parent_task_id,
    goalId: r.goal_id,
    projectId: r.project_id,
    sprintNumber: r.sprint_number,
    qaRequired: r.qa_required,
    acceptanceCriteria: r.acceptance_criteria,
    resultSummary: r.result_summary,
    retryCount: r.retry_count,
    doctorAttempts: r.doctor_attempts,
    failureReason: r.failure_reason,
    freshInputTokens: r.fresh_input_tokens,
    cachedInputTokens: r.cached_input_tokens,
    cachedInputTokensKnown: r.cached_input_tokens_known,
    totalContextTokens: r.total_context_tokens,
    estimatedBillableCostCents: r.estimated_billable_cost_cents,
    tokensInput: r.tokens_input,
    tokensOutput: r.tokens_output,
    costCents: r.cost_cents,
    usage: toPublicUsageSummary({
      usageDetails: r.usage_details,
      tokensInput: r.tokens_input,
      tokensOutput: r.tokens_output,
      costCents: r.cost_cents,
    }),
    modelUsed: r.model_used,
    goalBudget,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    workProducts: workProducts.map(mapWorkProductRow),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { user } = authz;
    const { id } = await params;

    const rows = await sql`
      SELECT t.id, t.hive_id, t.assigned_to, t.created_by, t.status, t.priority, t.title, t.brief,
             t.parent_task_id, t.goal_id, t.project_id, t.sprint_number, t.qa_required, t.acceptance_criteria,
             result_summary, retry_count, doctor_attempts, failure_reason,
             fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
             total_context_tokens, estimated_billable_cost_cents,
             usage_details, tokens_input, tokens_output, cost_cents, model_used,
             started_at, completed_at, t.created_at, t.updated_at,
             g.budget_cents AS goal_budget_cents,
             g.spent_cents AS goal_spent_cents,
             g.budget_state AS goal_budget_state,
             g.budget_warning_triggered_at AS goal_budget_warning_triggered_at,
             g.budget_enforced_at AS goal_budget_enforced_at,
             g.budget_enforcement_reason AS goal_budget_enforcement_reason
      FROM tasks t
      LEFT JOIN goals g ON g.id = t.goal_id
      WHERE t.id = ${id}
    `;

    if (rows.length === 0) {
      return jsonError("Task not found", 404);
    }

    const taskRow = rows[0] as unknown as TaskRow;
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, taskRow.hive_id);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this task", 403);
      }
    }

    const diagnostic = await readLatestCodexEmptyOutputDiagnostic(sql, id);
    const provenance = await readLatestTaskContextProvenance(sql, id);

    const workProducts = await sql`
      SELECT id, content, summary, artifact_kind, mime_type, width, height,
             model_name, model_snapshot, prompt_tokens, output_tokens, cost_cents,
             usage_details,
             metadata, created_at
      FROM work_products
      WHERE task_id = ${id}
      ORDER BY created_at ASC
    `;
    const task = mapTaskRow(taskRow, workProducts as unknown as WorkProductRow[]);

    return jsonOk({
      ...task,
      provenance,
      runtimeDiagnostics: {
        codexEmptyOutput: diagnostic,
      },
    });
  } catch {
    return jsonError("Failed to fetch task", 500);
  }
}
