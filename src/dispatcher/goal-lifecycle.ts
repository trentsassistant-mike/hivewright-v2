import type { Sql } from "postgres";

// The `last_woken_sprint` column is managed by drizzle migration 0018. No
// runtime DDL here — having the dispatcher retry ALTER TABLE on every poll
// spammed Postgres with 42701 NOTICEs.

export interface NewGoal {
  id: string;
  hiveId: string;
  title: string;
  description: string | null;
}

export async function findNewGoals(sql: Sql): Promise<NewGoal[]> {
  const rows = await sql`
    SELECT id, hive_id, title, description
    FROM goals
    WHERE status = 'active' AND session_id IS NULL
  `;
  return rows.map((r) => ({
    id: r.id as string,
    hiveId: r.hive_id as string,
    title: r.title as string,
    description: (r.description ?? null) as string | null,
  }));
}

export interface CompletedSprintForWakeUp {
  goalId: string;
  sprintNumber: number;
  sessionId: string;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
}

export async function markSprintWakeUpSent(sql: Sql, goalId: string, sprintNumber: number): Promise<void> {
  await sql`
    UPDATE goals
    SET last_woken_sprint = GREATEST(COALESCE(last_woken_sprint, 0), ${sprintNumber})
    WHERE id = ${goalId}
  `;
}

/**
 * Roll a goal's `last_woken_sprint` back to `sprintNumber - 1` so the next
 * lifecycle poll re-detects the completed sprint as needing a wake-up.
 *
 * Used as the failure path of the "mark before wake" pattern: if the
 * blocking `wakeUpSupervisor` call dies (dispatcher restart, network, agent
 * spawn fail), we revert the optimistic mark to avoid a permanent stall.
 *
 * Guarded by `WHERE last_woken_sprint = sprintNumber` so we don't clobber a
 * later-sprint marker that landed concurrently — only roll back if we still
 * own this slot.
 */
export async function revertSprintWakeUp(
  sql: Sql,
  goalId: string,
  sprintNumber: number,
): Promise<void> {
  await sql`
    UPDATE goals
    SET last_woken_sprint = ${sprintNumber - 1}
    WHERE id = ${goalId}
      AND last_woken_sprint = ${sprintNumber}
  `;
}

export interface OrphanedWakeUp {
  goalId: string;
  sprintNumber: number;
  updatedAt: Date;
}

export interface SupervisorWakeReconciliationCandidate {
  goalId: string;
  sprintNumber: number;
  sessionId: string;
  newestTaskId: string;
  newestTaskStatus: string;
  newestTaskUpdatedAt: Date;
}

/**
 * Find goals whose supervisor wake-up was started but never completed —
 * `last_woken_sprint` was bumped, but no higher-numbered sprint tasks ever
 * appeared. Used by the dispatcher boot recovery sweep to rescue goals
 * stranded by a mid-wake crash/restart.
 *
 * Filters:
 *   - status = active, has a session_id (supervisor exists)
 *   - last_woken_sprint matches the highest sprint number on tasks
 *   - that sprint has at least one task and zero open tasks
 *   - no higher-numbered sprint tasks exist
 *   - goal hasn't been touched in `staleAfterMinutes` (default 10) minutes,
 *     so we don't yank a wake-up that's actively in flight
 */
export async function findOrphanedWakeUps(
  sql: Sql,
  staleAfterMinutes = 10,
): Promise<OrphanedWakeUp[]> {
  const rows = await sql`
    WITH sprint_stats AS (
      SELECT
        t.goal_id,
        t.sprint_number,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE t.status IN ('pending','active','blocked','in_review')) AS open_count
      FROM tasks t
      WHERE t.goal_id IS NOT NULL AND t.sprint_number IS NOT NULL
      GROUP BY t.goal_id, t.sprint_number
    ),
    max_sprint_per_goal AS (
      SELECT goal_id, MAX(sprint_number) AS max_sprint FROM sprint_stats GROUP BY goal_id
    )
    SELECT g.id AS goal_id, g.last_woken_sprint AS sprint_number, g.updated_at
    FROM goals g
    JOIN max_sprint_per_goal m ON m.goal_id = g.id
    JOIN sprint_stats ss ON ss.goal_id = g.id AND ss.sprint_number = m.max_sprint
    WHERE g.status = 'active'
      AND g.session_id IS NOT NULL
      AND g.last_woken_sprint = m.max_sprint
      AND ss.total > 0
      AND ss.open_count = 0
      AND g.updated_at < NOW() - (${staleAfterMinutes} * INTERVAL '1 minute')
  `;
  return rows.map((r) => ({
    goalId: r.goal_id as string,
    sprintNumber: r.sprint_number as number,
    updatedAt: r.updated_at as Date,
  }));
}

export async function findCompletedSprintsForWakeUp(sql: Sql): Promise<CompletedSprintForWakeUp[]> {
  const rows = await sql`
    WITH sprint_stats AS (
      SELECT
        t.goal_id,
        t.sprint_number,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE t.status = 'completed') AS completed_count,
        COUNT(*) FILTER (WHERE t.status IN ('failed', 'unresolvable')) AS failed_count,
        COUNT(*) FILTER (WHERE t.status = 'cancelled') AS cancelled_count,
        COUNT(*) FILTER (WHERE t.status IN ('pending', 'active', 'blocked', 'in_review')) AS open_count
      FROM tasks t
      JOIN goals g ON g.id = t.goal_id
      WHERE t.goal_id IS NOT NULL
        AND t.sprint_number IS NOT NULL
        AND g.status = 'active'
        AND g.session_id IS NOT NULL
      GROUP BY t.goal_id, t.sprint_number
    )
    SELECT
      ss.goal_id,
      ss.sprint_number,
      g.session_id,
      ss.completed_count,
      ss.failed_count,
      ss.cancelled_count
    FROM sprint_stats ss
    JOIN goals g ON g.id = ss.goal_id
    WHERE ss.total > 0
      AND ss.open_count = 0
      -- Wake up whenever all tasks have settled (no pending/active/blocked/in_review),
      -- regardless of the completed/failed/cancelled mix. The wake-up prompt surfaces
      -- every category explicitly so the supervisor can replan failed or cancelled work.
      AND COALESCE(g.last_woken_sprint, 0) < ss.sprint_number
      -- Only wake up if no higher-numbered sprint tasks exist yet
      AND NOT EXISTS (
        SELECT 1 FROM tasks t2
        WHERE t2.goal_id = ss.goal_id
          AND t2.sprint_number > ss.sprint_number
      )
  `;
  return rows.map((r) => ({
    goalId: r.goal_id as string,
    sprintNumber: r.sprint_number as number,
    sessionId: r.session_id as string,
    completedCount: Number(r.completed_count ?? 0),
    failedCount: Number(r.failed_count ?? 0),
    cancelledCount: Number(r.cancelled_count ?? 0),
  }));
}

/**
 * Periodic recovery for the state-transition gap that normal sprint wake-up
 * detection cannot see: the final sprint task is already terminal and
 * last_woken_sprint already equals that sprint, but the wake edge was dropped
 * during a dispatcher restart before the supervisor actually progressed.
 */
export async function findSupervisorWakeReconciliationCandidates(
  sql: Sql,
  staleAfterMinutes = 2,
): Promise<SupervisorWakeReconciliationCandidate[]> {
  const rows = await sql`
    WITH ranked_tasks AS (
      SELECT
        t.id,
        t.goal_id,
        t.sprint_number,
        t.status,
        t.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY t.goal_id
          ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC
        ) AS rn
      FROM tasks t
      JOIN goals g ON g.id = t.goal_id
      WHERE t.goal_id IS NOT NULL
        AND t.sprint_number IS NOT NULL
        AND g.status = 'active'
        AND g.session_id IS NOT NULL
    )
    SELECT
      g.id AS goal_id,
      rt.sprint_number,
      g.session_id,
      rt.id AS newest_task_id,
      rt.status AS newest_task_status,
      rt.updated_at AS newest_task_updated_at
    FROM ranked_tasks rt
    JOIN goals g ON g.id = rt.goal_id
    WHERE rt.rn = 1
      AND rt.status IN ('completed', 'failed', 'cancelled', 'unresolvable')
      AND rt.updated_at < NOW() - (${staleAfterMinutes} * INTERVAL '1 minute')
      AND g.last_woken_sprint = rt.sprint_number
      AND NOT EXISTS (
        SELECT 1
        FROM tasks open_tasks
        WHERE open_tasks.goal_id = g.id
          AND open_tasks.status IN ('pending', 'active', 'blocked', 'in_review')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM tasks later_tasks
        WHERE later_tasks.goal_id = g.id
          AND later_tasks.sprint_number IS NOT NULL
          AND later_tasks.sprint_number > rt.sprint_number
      )
  `;

  return rows.map((r) => ({
    goalId: r.goal_id as string,
    sprintNumber: r.sprint_number as number,
    sessionId: r.session_id as string,
    newestTaskId: r.newest_task_id as string,
    newestTaskStatus: r.newest_task_status as string,
    newestTaskUpdatedAt: r.newest_task_updated_at as Date,
  }));
}
