import type { Sql } from "postgres";

export type ExecutionCapsuleStatus = "active" | "qa_failed" | "completed" | "abandoned";

export type ExecutionCapsule = {
  id: string;
  taskId: string;
  adapterType: string;
  model: string | null;
  sessionId: string;
  status: ExecutionCapsuleStatus;
  reworkCount: number;
  lastQaFeedback: string | null;
};

type ExecutionCapsuleRow = {
  id: string;
  task_id: string;
  adapter_type: string;
  model: string | null;
  session_id: string | null;
  status: string;
  rework_count: number | string | null;
  last_qa_feedback: string | null;
};

export async function findReusableExecutionCapsule(
  sql: Sql,
  input: { taskId: string; adapterType: string },
): Promise<ExecutionCapsule | null> {
  const [row] = await sql<ExecutionCapsuleRow[]>`
    SELECT id, task_id, adapter_type, model, session_id, status, rework_count, last_qa_feedback
    FROM task_execution_capsules
    WHERE task_id = ${input.taskId}
      AND adapter_type = ${input.adapterType}
      AND session_id IS NOT NULL
      AND status IN ('active', 'qa_failed')
    LIMIT 1
  `;

  if (!row?.session_id) return null;

  return {
    id: row.id,
    taskId: row.task_id,
    adapterType: row.adapter_type,
    model: row.model ?? null,
    sessionId: row.session_id,
    status: normalizeCapsuleStatus(row.status),
    reworkCount: Number(row.rework_count ?? 0),
    lastQaFeedback: row.last_qa_feedback ?? null,
  };
}

export async function upsertExecutionCapsule(
  sql: Sql,
  input: {
    taskId: string;
    hiveId: string;
    adapterType: string;
    model: string | null;
    sessionId: string | null;
    lastOutput: string;
    fallbackReason?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO task_execution_capsules (
      task_id,
      hive_id,
      adapter_type,
      model,
      session_id,
      status,
      last_output,
      fallback_reason,
      updated_at
    )
    VALUES (
      ${input.taskId},
      ${input.hiveId},
      ${input.adapterType},
      ${input.model},
      ${input.sessionId},
      'active',
      ${input.lastOutput},
      ${input.fallbackReason ?? null},
      NOW()
    )
    ON CONFLICT (task_id)
    DO UPDATE SET
      adapter_type = EXCLUDED.adapter_type,
      model = EXCLUDED.model,
      session_id = COALESCE(EXCLUDED.session_id, task_execution_capsules.session_id),
      status = EXCLUDED.status,
      last_output = EXCLUDED.last_output,
      fallback_reason = EXCLUDED.fallback_reason,
      updated_at = NOW()
  `;
}

export async function markCapsuleQaFailed(
  sql: Sql,
  input: { taskId: string; feedback: string | null },
): Promise<void> {
  await sql`
    UPDATE task_execution_capsules
    SET status = 'qa_failed',
        qa_state = 'failed',
        rework_count = rework_count + 1,
        last_qa_feedback = ${input.feedback},
        updated_at = NOW()
    WHERE task_id = ${input.taskId}
  `;
}

export async function markCapsuleCompleted(sql: Sql, taskId: string): Promise<void> {
  await sql`
    UPDATE task_execution_capsules
    SET status = 'completed',
        qa_state = 'passed',
        updated_at = NOW()
    WHERE task_id = ${taskId}
  `;
}

export function buildQaReworkPrompt(input: {
  title: string;
  brief: string;
  acceptanceCriteria: string | null;
  feedback: string | null;
}): string {
  return [
    "## QA Rework Required",
    "",
    `Task: ${input.title}`,
    "",
    "Continue the existing task session and address the QA feedback below.",
    "Do not restart from scratch unless the existing approach is unusable.",
    "",
    "### Current Brief",
    input.brief,
    "",
    input.acceptanceCriteria
      ? ["### Acceptance Criteria", input.acceptanceCriteria].join("\n")
      : "",
    "",
    "### QA Feedback",
    input.feedback?.trim() || "No QA feedback captured.",
  ].filter((part) => part !== "").join("\n");
}

function normalizeCapsuleStatus(status: string): ExecutionCapsuleStatus {
  if (
    status === "active" ||
    status === "qa_failed" ||
    status === "completed" ||
    status === "abandoned"
  ) {
    return status;
  }
  return "active";
}
