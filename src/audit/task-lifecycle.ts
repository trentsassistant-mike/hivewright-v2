import type { Sql } from "postgres";
import {
  AGENT_AUDIT_EVENTS,
  type AgentAuditActor,
  recordAgentAuditEvent,
} from "./agent-events";

export interface TaskLifecycleTransitionAuditInput {
  taskId: string;
  hiveId?: string | null;
  goalId?: string | null;
  previousStatus?: string | null;
  nextStatus: string;
  actor?: AgentAuditActor;
  source: string;
  reason?: string | null;
  errorSummary?: string | null;
}

type TaskAuditContextRow = {
  hive_id: string;
  goal_id: string | null;
};

function summarizeAuditText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

export async function recordTaskLifecycleTransition(
  sql: Sql,
  input: TaskLifecycleTransitionAuditInput,
): Promise<void> {
  if (input.previousStatus === input.nextStatus) return;

  let hiveId = input.hiveId ?? null;
  let goalId = input.goalId ?? null;

  if (!hiveId) {
    const [row] = await sql<TaskAuditContextRow[]>`
      SELECT hive_id, goal_id
      FROM tasks
      WHERE id = ${input.taskId}
      LIMIT 1
    `;
    if (!row) return;
    hiveId = row.hive_id;
    goalId = row.goal_id;
  }

  const metadata: Record<string, unknown> = {
    taskId: input.taskId,
    hiveId,
    previousStatus: input.previousStatus ?? null,
    nextStatus: input.nextStatus,
    source: input.source,
  };
  if (goalId) metadata.goalId = goalId;
  const reason = summarizeAuditText(input.reason);
  const errorSummary = summarizeAuditText(input.errorSummary);
  if (reason) metadata.reason = reason;
  if (errorSummary) metadata.errorSummary = errorSummary;

  await recordAgentAuditEvent(sql, {
    eventType: AGENT_AUDIT_EVENTS.taskLifecycleTransition,
    actor: input.actor ?? { type: "system", id: input.source, label: input.source },
    hiveId,
    goalId,
    taskId: input.taskId,
    targetType: "task",
    targetId: input.taskId,
    outcome: "success",
    metadata,
  });
}

export async function recordTaskLifecycleTransitionBestEffort(
  sql: Sql,
  input: TaskLifecycleTransitionAuditInput,
): Promise<void> {
  try {
    await recordTaskLifecycleTransition(sql, input);
  } catch {
    // Audit writes must not break task execution or owner operations.
  }
}
