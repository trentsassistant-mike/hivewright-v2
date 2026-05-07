/**
 * task-log-writer.ts
 *
 * Writes a single output chunk to task_logs (for durable replay) and then
 * broadcasts it via pg_notify so any live SSE subscriber receives it within
 * milliseconds.
 *
 * Called exclusively by the dispatcher. Adapters receive a `ChunkCallback`
 * closure that calls this function — they do not import postgres directly.
 *
 * pg_notify channels:
 *   task_output:<taskId>  — consumed by GET /api/tasks/:id/stream
 *   goal_output:<goalId>  — consumed by GET /api/goals/:id/stream (fired only
 *                           when goalId is provided)
 *
 * pg_notify payload max: 8000 bytes (Postgres hard limit). Chunk text is
 * truncated to 7000 chars before serialisation to stay safely below that.
 */

import type { Sql } from "postgres";

export interface LogChunk {
  taskId: string;
  /** If set, also fires pg_notify on goal_output:<goalId> for the goal stream. */
  goalId?: string;
  /** Text content of the chunk. Empty string is valid (used for "done"). */
  chunk: string;
  /** stdout = normal output, stderr = error output, status = lifecycle message, diagnostic = structured runtime metadata, done = end-of-stream signal */
  type: "stdout" | "stderr" | "status" | "diagnostic" | "done";
}

export interface WrittenChunk extends LogChunk {
  /** Auto-increment DB row id. Used as SSE Last-Event-ID. */
  id: number;
  /** ISO 8601 UTC timestamp assigned at write time. */
  timestamp: string;
}

/**
 * Insert a chunk into task_logs and broadcast via pg_notify.
 *
 * Returns the written chunk including its DB id and timestamp so the caller
 * can use it in unit tests or logging without a second DB query.
 *
 * Errors are surfaced to the caller — wrap in try/catch if you want
 * fire-and-forget behaviour (the dispatcher does this).
 */
export async function writeTaskLog(sql: Sql, data: LogChunk): Promise<WrittenChunk> {
  const [row] = await sql`
    INSERT INTO task_logs (task_id, chunk, type)
    VALUES (${data.taskId}, ${data.chunk}, ${data.type})
    RETURNING id, timestamp
  `;

  const id = Number(row.id);
  const timestamp =
    row.timestamp instanceof Date
      ? row.timestamp.toISOString()
      : String(row.timestamp);

  const written: WrittenChunk = { ...data, id, timestamp };

  // pg_notify payload must be < 8000 bytes.
  // We truncate chunk text to 7000 chars to leave headroom for the JSON envelope.
  const payload = JSON.stringify({
    taskId: data.taskId,
    chunk: data.chunk.slice(0, 7000),
    type: data.type,
    id,
    timestamp,
  });

  // Channel name: "task_output:<uuid>" = 12 + 36 = 48 chars (well within 63-char limit).
  await sql`SELECT pg_notify(${`task_output:${data.taskId}`}, ${payload})`;

  // If the task belongs to a goal, also broadcast on the goal channel so that
  // GET /api/goals/:id/stream can aggregate output across all tasks in the goal.
  if (data.goalId) {
    const goalPayload = JSON.stringify({
      goalId: data.goalId,
      taskId: data.taskId,
      chunk: data.chunk.slice(0, 7000),
      type: data.type,
      id,
      timestamp,
    });
    // Channel name: "goal_output:<uuid>" = 12 + 36 = 48 chars (well within 63-char limit).
    await sql`SELECT pg_notify(${`goal_output:${data.goalId}`}, ${goalPayload})`;
  }

  return written;
}
