import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { syncRoleLibrary } from "@/roles/sync";
import { buildSessionContext } from "@/dispatcher/session-builder";
import type { ClaimedTask } from "@/dispatcher/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const TEST_SLUG = "test-biz-session-att";

let bizId: string;

function makeTask(overrides: Partial<ClaimedTask>): ClaimedTask {
  return {
    id: "00000000-0000-0000-0000-000000000088",
    hiveId: bizId,
    assignedTo: "dev-agent",
    createdBy: "owner",
    status: "active",
    priority: 5,
    title: "att-test-task",
    brief: "Fix the login form.",
    parentTaskId: null,
    goalId: null,
    sprintNumber: null,
    qaRequired: false,
    acceptanceCriteria: null,
    retryCount: 0,
    doctorAttempts: 0,
    failureReason: null,
    projectId: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAll(sql);
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES (${TEST_SLUG}, 'Session Att Test', 'digital', '/tmp')
    RETURNING *
  `;
  bizId = biz.id;
});

describe("session-builder: attachments section in brief", () => {
  it("appends ## Attachments when task has its own attachments", async () => {
    const taskId = "00000000-0000-0000-0000-000000000088";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, title, brief, qa_required)
      VALUES (${taskId}, ${bizId}, 'dev-agent', 'owner', 'att-test-task', 'Fix the login form.', false)
    `;
    await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES
        (${taskId}, 'screenshot.png', '/tmp/screenshot.png', 'image/png', 12345),
        (${taskId}, 'notes.pdf', '/tmp/notes.pdf', 'application/pdf', 67890)
    `;

    const ctx = await buildSessionContext(sql, makeTask({ id: taskId }));

    expect(ctx.task.brief).toContain("## Attachments");
    expect(ctx.task.brief).toContain("- screenshot.png: /tmp/screenshot.png");
    expect(ctx.task.brief).toContain("- notes.pdf: /tmp/notes.pdf");
  });

  it("inherits goal-level attachments when task is linked to a goal", async () => {
    const taskId = "00000000-0000-0000-0000-000000000088";
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${bizId}, 'g', 'g')
      RETURNING id
    `;
    const goalId = goal.id as string;

    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, title, brief, qa_required, goal_id)
      VALUES (${taskId}, ${bizId}, 'dev-agent', 'owner', 't', 'Build the about page.', false, ${goalId})
    `;
    await sql`
      INSERT INTO task_attachments (goal_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${goalId}, 'brand-doc.pdf', '/tmp/brand-doc.pdf', 'application/pdf', 9000)
    `;

    const ctx = await buildSessionContext(
      sql,
      makeTask({ id: taskId, goalId, brief: "Build the about page." }),
    );

    expect(ctx.task.brief).toContain("## Attachments");
    expect(ctx.task.brief).toContain("- brand-doc.pdf: /tmp/brand-doc.pdf");
  });

  it("does not append ## Attachments when task and goal have no attachments", async () => {
    const taskId = "00000000-0000-0000-0000-000000000088";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, title, brief, qa_required)
      VALUES (${taskId}, ${bizId}, 'dev-agent', 'owner', 't', 'Plain task.', false)
    `;

    const ctx = await buildSessionContext(sql, makeTask({ id: taskId, brief: "Plain task." }));

    expect(ctx.task.brief).not.toContain("## Attachments");
  });
});
