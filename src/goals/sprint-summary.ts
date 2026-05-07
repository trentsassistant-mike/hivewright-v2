import type { Sql } from "postgres";
import type { SprintSummary, GoalStatus } from "./types";

export async function buildSprintSummary(sql: Sql, goalId: string, sprintNumber: number): Promise<SprintSummary> {
  const completed = await sql`
    SELECT id, title, result_summary, assigned_to
    FROM tasks WHERE goal_id = ${goalId} AND sprint_number = ${sprintNumber} AND status = 'completed'
  `;
  const failed = await sql`
    SELECT id, title, failure_reason, assigned_to
    FROM tasks WHERE goal_id = ${goalId} AND sprint_number = ${sprintNumber} AND status IN ('failed', 'unresolvable')
  `;
  const cancelled = await sql`
    SELECT id, title, assigned_to
    FROM tasks WHERE goal_id = ${goalId} AND sprint_number = ${sprintNumber} AND status = 'cancelled'
  `;

  return {
    goalId, sprintNumber,
    tasksCompleted: completed.map((t) => ({ id: t.id as string, title: t.title as string, resultSummary: (t.result_summary ?? null) as string | null, assignedTo: t.assigned_to as string })),
    tasksFailed: failed.map((t) => ({ id: t.id as string, title: t.title as string, failureReason: (t.failure_reason ?? null) as string | null, assignedTo: t.assigned_to as string })),
    tasksCancelled: cancelled.map((t) => ({ id: t.id as string, title: t.title as string, assignedTo: t.assigned_to as string })),
  };
}

export async function getGoalStatus(sql: Sql, goalId: string): Promise<GoalStatus> {
  const [goal] = await sql`SELECT id, title, description, status, budget_cents, spent_cents FROM goals WHERE id = ${goalId}`;
  const [sprintCount] = await sql`SELECT COALESCE(MAX(sprint_number), 0)::int as max_sprint FROM tasks WHERE goal_id = ${goalId}`;
  const [currentSprint] = await sql`SELECT COALESCE(MAX(sprint_number), 0)::int as current FROM tasks WHERE goal_id = ${goalId} AND status NOT IN ('completed', 'cancelled')`;
  const subGoals = await sql`SELECT id, title, status FROM goals WHERE parent_id = ${goalId}`;

  return {
    goalId: goal.id as string, title: goal.title as string, description: (goal.description ?? null) as string | null,
    status: goal.status as string, budgetCents: (goal.budget_cents ?? null) as number | null,
    spentCents: (goal.spent_cents ?? 0) as number, currentSprint: (currentSprint?.current ?? 0) as number,
    totalSprints: (sprintCount?.max_sprint ?? 0) as number,
    subGoals: subGoals.map((g) => ({ id: g.id as string, title: g.title as string, status: g.status as string })),
  };
}
