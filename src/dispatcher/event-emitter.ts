import type { Sql } from "postgres";

export interface TaskEvent {
  type: "task_claimed" | "task_completed" | "task_failed" | "task_created" | "task_cancelled";
  taskId: string;
  title: string;
  assignedTo: string;
  hiveId?: string;
}

export interface DecisionEvent {
  type: "decision_created" | "decision_resolved";
  decisionId: string;
  title: string;
  priority: string;
  hiveId?: string;
}

export async function emitTaskEvent(sql: Sql, event: TaskEvent): Promise<void> {
  const payload = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });
  await sql`SELECT pg_notify('task_events', ${payload})`;
}

export async function emitDecisionEvent(sql: Sql, event: DecisionEvent): Promise<void> {
  const payload = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });
  await sql`SELECT pg_notify('task_events', ${payload})`;
}
