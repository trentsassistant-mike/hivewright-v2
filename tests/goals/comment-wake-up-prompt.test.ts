import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { buildCommentWakeUpPrompt } from "@/goals/supervisor-session";

const BIZ = "22222222-2222-2222-2222-222222222222";

async function insertGoalWithComment(body: string, createdBy = "owner") {
  const [goal] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, description, status)
    VALUES (${BIZ}, 'fix the docs page', 'the menu disappears on docs', 'active')
    RETURNING id
  `;
  const [comment] = await sql<{ id: string }[]>`
    INSERT INTO goal_comments (goal_id, body, created_by)
    VALUES (${goal.id}, ${body}, ${createdBy})
    RETURNING id
  `;
  return { goalId: goal.id, commentId: comment.id };
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${BIZ}, 'bz', 'Bz', 'digital')
  `;
});

describe("buildCommentWakeUpPrompt", () => {
  it("embeds the comment body and goal id in the prompt", async () => {
    const { goalId, commentId } = await insertGoalWithComment("this should be resolved now");
    const prompt = await buildCommentWakeUpPrompt(sql, goalId, commentId);

    expect(prompt).toContain("Owner Comment Received");
    expect(prompt).toContain("this should be resolved now");
    expect(prompt).toContain(goalId);
  });

  it("lists tasks on the goal with their statuses", async () => {
    const { goalId, commentId } = await insertGoalWithComment("please retry this");
    const inserted = await sql<{ id: string; title: string }[]>`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, status, priority, title, brief, failure_reason)
      VALUES
        (${BIZ}, ${goalId}, 'dev-agent', 'supervisor', 'unresolvable', 5, 'first task', 'b', 'config.toml bad'),
        (${BIZ}, ${goalId}, 'qa', 'supervisor', 'completed', 5, 'second task', 'b', null)
      RETURNING id, title
    `;
    const prompt = await buildCommentWakeUpPrompt(sql, goalId, commentId);
    const failedTask = inserted.find((task) => task.title === "first task")!;
    expect(prompt).toContain("first task");
    expect(prompt).toContain(failedTask.id);
    expect(prompt).toContain("[unresolvable]");
    expect(prompt).toContain("config.toml bad");
    expect(prompt).toContain("second task");
    expect(prompt).toContain("[completed]");
  });

  it("instructs replacement work to carry the source task id", async () => {
    const { goalId, commentId } = await insertGoalWithComment("please retry this");
    await sql`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, status, priority, title, brief, failure_reason)
      VALUES (${BIZ}, ${goalId}, 'dev-agent', 'supervisor', 'unresolvable', 5, 'first task', 'b', 'config.toml bad')
    `;

    const prompt = await buildCommentWakeUpPrompt(sql, goalId, commentId);

    expect(prompt).toContain("sourceTaskId");
    expect(prompt).toContain("same failed or cancelled task");
  });

  it("instructs the supervisor to reply with createdBy='goal-supervisor'", async () => {
    const { goalId, commentId } = await insertGoalWithComment("what's the status?");
    const prompt = await buildCommentWakeUpPrompt(sql, goalId, commentId);
    expect(prompt).toMatch(/createdBy[^\n]+goal-supervisor/);
    expect(prompt).toContain(`/api/goals/${goalId}/comments`);
  });

  it("falls back gracefully when the comment row is gone (race on delete)", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${BIZ}, 'g', 'd', 'active')
      RETURNING id
    `;
    const prompt = await buildCommentWakeUpPrompt(sql, goal.id, "00000000-0000-0000-0000-000000000000");
    expect(prompt).toContain("no longer available");
    expect(prompt).toContain(goal.id);
  });
});
