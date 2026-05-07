import { describe, it, expect, beforeEach } from "vitest";
import { checkSprintCompletion } from "@/dispatcher/sprint-tracker";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('sprint-test-biz', 'Sprint Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status)
    VALUES (${bizId}, 'sprint-test-goal', 'active')
    RETURNING *
  `;
  goalId = goal.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('sprint-test-role', 'SPT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});


describe("checkSprintCompletion", () => {
  it("detects a completed sprint", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'sprint-test-role', 'goal-supervisor', 'sprint-test-t1', 'B', ${goalId}, 1, 'completed'),
        (${bizId}, 'sprint-test-role', 'goal-supervisor', 'sprint-test-t2', 'B', ${goalId}, 1, 'completed')
    `;

    const completed = await checkSprintCompletion(sql);
    expect(completed.some((c) => c.goalId === goalId && c.sprintNumber === 1)).toBe(true);
  });

  it("does not report incomplete sprints", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'sprint-test-role', 'goal-supervisor', 'sprint-test-t3', 'B', ${goalId}, 2, 'completed'),
        (${bizId}, 'sprint-test-role', 'goal-supervisor', 'sprint-test-t4', 'B', ${goalId}, 2, 'active')
    `;

    const completed = await checkSprintCompletion(sql);
    expect(completed.some((c) => c.goalId === goalId && c.sprintNumber === 2)).toBe(false);
  });
});
