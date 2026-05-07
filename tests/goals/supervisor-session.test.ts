import { describe, it, expect, beforeEach } from "vitest";
import {
  buildSupervisorInitialPrompt,
  buildSprintWakeUpPrompt,
} from "@/goals/supervisor-session";
import { upsertGoalPlan } from "@/goals/goal-documents";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('supsess-biz', 'SupSess Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id as string;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('suptool-role', 'SupTool Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  // Set a dummy session_id so the running dispatcher's findNewGoals query
  // (which filters WHERE session_id IS NULL) ignores this test fixture.
  // Without this, a live dispatcher races the test and creates real tasks
  // against our goal, breaking cleanup.
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, description, status, budget_cents, session_id)
    VALUES (${bizId}, 'supsess-goal', 'ship a feature', 'active', 5000, 'gs-supsess-test-fixture')
    RETURNING *
  `;
  goalId = goal.id as string;
});

describe("buildSupervisorInitialPrompt", () => {
  it("instructs the supervisor to create a plan BEFORE execution tasks", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt.toLowerCase()).toContain("create_goal_plan");
    expect(prompt.toLowerCase()).toMatch(/before.*(creat|execut).*task/);
  });

  it("lists required plan sections", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toMatch(/Goal Summary/);
    expect(prompt).toMatch(/Success Criteria/);
    expect(prompt).toMatch(/Risks/);
    expect(prompt).toMatch(/Workstreams/);
    expect(prompt).toMatch(/Evidence Required/);
  });

  it("requires acceptance criteria on implementation tasks", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt.toLowerCase()).toContain("acceptance criteria");
  });

  it("instructs the supervisor to bake commit-discipline into every task brief", async () => {
    // Closes a recurring problem where executor agents produced files but
    // never ran `git commit`, leaving enormous piles of uncommitted work on
    // main. Every brief must explicitly tell the executor to commit.
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt.toLowerCase()).toMatch(/commit/);
    expect(prompt.toLowerCase()).toMatch(/git (add|commit)/);
  });

  it("includes create_goal_plan in the tool list", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("create_goal_plan");
  });
});

describe("buildSprintWakeUpPrompt", () => {
  it("includes a plan summary when a plan exists", async () => {
    await upsertGoalPlan(sql, goalId, {
      title: "supsess-plan",
      body: "# Goal Summary\nShip it\n## Success Criteria\n- feature renders",
      createdBy: "goal-supervisor",
    });
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-done', 'b', ${goalId}, 1, 'completed')
    `;
    const prompt = await buildSprintWakeUpPrompt(sql, goalId, 1);
    expect(prompt.toLowerCase()).toContain("plan");
    expect(prompt).toContain("supsess-plan");
  });

  it("shows explicit cancelled handling instructions when cancelled tasks exist", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-ok', 'b', ${goalId}, 1, 'completed'),
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-gone', 'b', ${goalId}, 1, 'cancelled')
    `;
    const prompt = await buildSprintWakeUpPrompt(sql, goalId, 1);
    expect(prompt).toMatch(/Cancelled Tasks/);
    // Must tell supervisor to explicitly handle cancellations, not ignore them
    expect(prompt.toLowerCase()).toMatch(/cancell[\s\S]*(retry|replan|reason|decide|explain)/);
  });

  it("does not treat cancelled tasks as successful progress", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-c1', 'b', ${goalId}, 1, 'cancelled'),
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-c2', 'b', ${goalId}, 1, 'cancelled')
    `;
    const prompt = await buildSprintWakeUpPrompt(sql, goalId, 1);
    // Should NOT claim the sprint is "complete" with zero completed tasks
    expect(prompt).not.toMatch(/sprint.*(complete|succeeded|done)/i);
  });
});
