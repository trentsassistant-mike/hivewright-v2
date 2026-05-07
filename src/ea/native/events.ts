import type { Sql } from "postgres";

export type EaChatEventType =
  | "ea_message_created"
  | "ea_message_updated"
  | "ea_turn_failed";

export interface EaChatEvent {
  type: EaChatEventType;
  hiveId: string;
  threadId: string;
  messageId?: string;
}

export async function emitEaChatEvent(
  sql: Sql,
  event: EaChatEvent,
): Promise<void> {
  const payload = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });
  await sql`SELECT pg_notify('task_events', ${payload})`;
}
