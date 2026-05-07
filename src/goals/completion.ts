import type { Sql } from "postgres";
import { sendNotification } from "../notifications/sender";
import { pruneGoalSupervisor } from "../openclaw/goal-supervisor-cleanup";
import { verifyLandedState } from "../software-pipeline/landed-state-gate";

export interface CompleteGoalOptions {
  /** Who initiated the completion. Defaults to 'goal-supervisor'. */
  createdBy?: string;
  /** Task IDs that constitute evidence the success criteria were met. */
  evidenceTaskIds?: string[];
  /** Work product IDs that constitute evidence. */
  evidenceWorkProductIds?: string[];
}

export async function completeGoal(
  sql: Sql,
  goalId: string,
  completionSummary: string,
  options: CompleteGoalOptions = {},
): Promise<void> {
  const landed = await verifyLandedState();
  if (!landed.ok) {
    throw new Error(`Goal completion blocked: ${landed.failures.join(", ")}`);
  }

  const [goal] = await sql`SELECT hive_id, title FROM goals WHERE id = ${goalId}`;
  if (!goal) throw new Error(`Goal not found: ${goalId}`);

  const createdBy = options.createdBy ?? "goal-supervisor";
  // Evidence policy: keys are present ONLY when their array is non-empty.
  // A no-evidence completion writes `{}` to the jsonb column (not
  // `{ taskIds: [], workProductIds: [] }`). Downstream readers (the
  // POST /api/goals/[id]/complete idempotency response, dashboard views)
  // must treat missing keys and empty arrays as semantically equivalent.
  const evidence: Record<string, string[]> = {};
  if (options.evidenceTaskIds && options.evidenceTaskIds.length > 0) {
    evidence.taskIds = options.evidenceTaskIds;
  }
  if (options.evidenceWorkProductIds && options.evidenceWorkProductIds.length > 0) {
    evidence.workProductIds = options.evidenceWorkProductIds;
  }

  // 1. Mark as achieved and clear session
  await sql`
    UPDATE goals SET status = 'achieved', session_id = NULL, updated_at = NOW()
    WHERE id = ${goalId}
  `;

  // 1b. Cascade-cancel every non-terminal task that transitively belongs to
  // this goal (direct children + their doctor / QA / replan descendants via
  // parent_task_id). A goal being marked achieved by the supervisor means
  // the underlying failures are no longer actionable — leaving them as
  // 'failed' or 'unresolvable' pollutes the owner-brief counters (e.g. the
  // "N unresolvable tasks." banner). Terminal statuses (completed,
  // cancelled, superseded) are preserved so history is honest; only stuck
  // non-terminal ones are closed out.
  await sql`
    WITH RECURSIVE goal_task_tree AS (
      SELECT id, status FROM tasks WHERE goal_id = ${goalId}
      UNION
      SELECT t.id, t.status FROM tasks t
      JOIN goal_task_tree gt ON t.parent_task_id = gt.id
    )
    UPDATE tasks
    SET status = 'cancelled',
        result_summary = CASE
          WHEN result_summary IS NULL OR result_summary = ''
            THEN 'Cancelled by goal completion (parent goal marked achieved)'
          WHEN result_summary LIKE '%Cancelled by goal completion (parent goal marked achieved)%'
            THEN result_summary
          ELSE result_summary || E'\n[Cancelled by goal completion (parent goal marked achieved)]'
        END,
        failure_reason = NULL,
        updated_at = NOW()
    WHERE id IN (
      SELECT id FROM goal_task_tree
      WHERE status NOT IN ('completed', 'cancelled', 'superseded')
    )
  `;

  // 2. Write completion summary to hive memory
  await sql`
    INSERT INTO hive_memory (hive_id, category, content, confidence, sensitivity)
    VALUES (${goal.hive_id}, 'general', ${`Goal "${goal.title}" achieved: ${completionSummary}`}, 1.0, 'internal')
  `;

  // 3. Write audit row to goal_completions
  await sql`
    INSERT INTO goal_completions (goal_id, summary, evidence, created_by)
    VALUES (${goalId}, ${completionSummary}, ${sql.json(evidence)}, ${createdBy})
  `;

  // 3b. Prune the goal-supervisor entry from ~/.openclaw/ — the goal is terminal.
  await pruneGoalSupervisor(sql, goalId);

  // 4. External notification
  await sendNotification(sql, {
    // postgres-js returns untyped rows; hive_id is uuid NOT NULL per schema.
    hiveId: goal.hive_id as string,
    title: `Goal achieved: ${goal.title}`,
    message: completionSummary,
    priority: "normal",
    source: "goal-completion",
  });
}
