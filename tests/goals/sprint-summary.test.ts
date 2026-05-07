import { describe, it, expect, beforeEach } from "vitest";
import { buildSprintSummary, getGoalStatus } from "@/goals/sprint-summary";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('sprint-sum-biz', 'Sprint Sum', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, description, status, budget_cents, spent_cents, session_id)
    VALUES (${bizId}, 'sprint-sum-goal', 'Build everything', 'active', 5000, 100, 'gs-sprint-sum-fixture')
    RETURNING *
  `;
  goalId = goal.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('sprint-sum-role', 'SS Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("buildSprintSummary", () => {
  it("builds a summary of completed sprint tasks", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status, result_summary)
      VALUES
        (${bizId}, 'sprint-sum-role', 'goal-supervisor', 'sprint-sum-t1', 'B', ${goalId}, 1, 'completed', 'Did the research'),
        (${bizId}, 'sprint-sum-role', 'goal-supervisor', 'sprint-sum-t2', 'B', ${goalId}, 1, 'completed', 'Built the thing'),
        (${bizId}, 'sprint-sum-role', 'goal-supervisor', 'sprint-sum-t3', 'B', ${goalId}, 1, 'failed', null)
    `;

    const summary = await buildSprintSummary(sql, goalId, 1);
    expect(summary.tasksCompleted.length).toBe(2);
    expect(summary.tasksFailed.length).toBe(1);
    expect(summary.tasksCompleted[0].resultSummary).toBe("Did the research");
  });
});

describe("getGoalStatus", () => {
  it("returns current goal status with sprint count", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'sprint-sum-role', 'goal-supervisor', 'sprint-sum-s1', 'B', ${goalId}, 1, 'completed'),
        (${bizId}, 'sprint-sum-role', 'goal-supervisor', 'sprint-sum-s2', 'B', ${goalId}, 2, 'active')
    `;

    const status = await getGoalStatus(sql, goalId);
    expect(status.title).toBe("sprint-sum-goal");
    expect(status.budgetCents).toBe(5000);
    expect(status.spentCents).toBe(100);
    expect(status.totalSprints).toBe(2);
  });

  it("includes sub-goals", async () => {
    await sql`
      INSERT INTO goals (hive_id, parent_id, title, status)
      VALUES (${bizId}, ${goalId}, 'sprint-sum-subgoal', 'active')
    `;

    const status = await getGoalStatus(sql, goalId);
    expect(status.subGoals.length).toBe(1);
    expect(status.subGoals[0].title).toBe("sprint-sum-subgoal");
  });
});
