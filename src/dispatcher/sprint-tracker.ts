import type { Sql } from "postgres";

export interface CompletedSprint {
  goalId: string;
  sprintNumber: number;
  taskCount: number;
}

export async function checkSprintCompletion(sql: Sql): Promise<CompletedSprint[]> {
  // Find all goal/sprint combos that have at least one task but zero non-terminal tasks
  const rows = await sql`
    WITH sprint_stats AS (
      SELECT
        goal_id,
        sprint_number,
        COUNT(*) as total_tasks,
        COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled')) as incomplete_tasks
      FROM tasks
      WHERE goal_id IS NOT NULL
        AND sprint_number IS NOT NULL
      GROUP BY goal_id, sprint_number
    )
    SELECT
      goal_id,
      sprint_number,
      total_tasks::int as task_count
    FROM sprint_stats
    WHERE incomplete_tasks = 0
  `;

  return rows.map((row) => ({
    goalId: row.goal_id as string,
    sprintNumber: row.sprint_number as number,
    taskCount: row.task_count as number,
  }));
}
