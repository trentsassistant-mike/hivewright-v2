import { pgTable, bigserial, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { tasks } from "./tasks";

/**
 * Persistent log of all output chunks emitted by adapters during task execution.
 *
 * Every chunk written by an adapter (stdout, stderr, status, diagnostic, done) is inserted
 * here AND broadcast via pg_notify('task_output:<taskId>', payload).
 *
 * The auto-increment `id` column provides strict global ordering. Clients use
 * it as the SSE Last-Event-ID to resume from an exact position on reconnect.
 *
 * Rows are retained until a background cleanup job removes them (default: 24h
 * after task completion). This allows late-joining SSE clients to replay full
 * history without any in-memory state in the Next.js process.
 */
export const taskLogs = pgTable("task_logs", {
  /** Auto-increment primary key. Used as SSE `id` (Last-Event-ID). */
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** FK to tasks table. Cascade-deleted when the task row is deleted. */
  taskId: uuid("task_id")
    .references(() => tasks.id, { onDelete: "cascade" })
    .notNull(),
  /** Text content of the chunk (may be empty string for "done" chunks). */
  chunk: text("chunk").notNull(),
  /** stdout | stderr | status | diagnostic | done */
  type: varchar("type", { length: 20 }).notNull(),
  /** Server-side timestamp when the chunk was written. */
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
});
