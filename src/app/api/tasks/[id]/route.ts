import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { readLatestCodexEmptyOutputDiagnostic } from "@/runtime-diagnostics/codex-empty-output";
import { readLatestTaskContextProvenance } from "@/provenance/task-context";

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
  tokens_input: number | null;
  tokens_output: number | null;
  cost_cents: number | null;
  model_used: string | null;
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
    usage: {
      promptTokens: r.prompt_tokens,
      outputTokens: r.output_tokens,
      costCents: r.cost_cents,
    },
    metadata: r.metadata,
    downloadUrl: isImage ? `/api/work-products/${r.id}/download` : null,
    createdAt: r.created_at,
  };
}

function mapTaskRow(r: TaskRow, workProducts: WorkProductRow[] = []) {
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
    modelUsed: r.model_used,
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
      SELECT id, hive_id, assigned_to, created_by, status, priority, title, brief,
             parent_task_id, goal_id, project_id, sprint_number, qa_required, acceptance_criteria,
             result_summary, retry_count, doctor_attempts, failure_reason,
             fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
             total_context_tokens, estimated_billable_cost_cents,
             tokens_input, tokens_output, cost_cents, model_used,
             started_at, completed_at, created_at, updated_at
      FROM tasks
      WHERE id = ${id}
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
