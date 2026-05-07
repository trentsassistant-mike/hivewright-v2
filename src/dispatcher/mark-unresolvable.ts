import type { Sql } from "postgres";

/**
 * Mark a task as unresolvable with the given reason. Used by the dispatcher
 * failure-handler in three exhaustion paths (recursion guard, doctor attempts
 * exhausted, retry attempts exhausted). Same SQL each time; this helper is
 * the single source of truth for that UPDATE.
 *
 * No transaction wrapper — all three call sites currently auto-commit.
 */
export async function markUnresolvable(sql: Sql, taskId: string, reason: string): Promise<void> {
  await sql`
    UPDATE tasks
    SET status = 'unresolvable', failure_reason = ${reason}, updated_at = NOW()
    WHERE id = ${taskId}
  `;
}
