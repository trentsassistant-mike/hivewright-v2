import { describe, it, expect, beforeEach } from "vitest";
import { GET as getTaskAttachments } from "@/app/api/tasks/[id]/attachments/route";
import { GET as getGoalAttachments } from "@/app/api/goals/[id]/attachments/route";
import { GET as getIdeaAttachments } from "@/app/api/hives/[id]/ideas/[ideaId]/attachments/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const TEST_SLUG = "test-biz-att-list";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Developer Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES (${TEST_SLUG}, 'Att List Biz', 'digital', '/tmp')
    RETURNING *
  `;
  bizId = biz.id;
});

describe("GET /api/tasks/[id]/attachments", () => {
  it("returns own + inherited goal attachments, ordered by uploaded_at", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${bizId}, 'g', 'g')
      RETURNING id
    `;
    const goalId = goal.id as string;

    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, qa_required, goal_id)
      VALUES (${bizId}, 'dev-agent', 'owner', 't', 'b', false, ${goalId})
      RETURNING id
    `;
    const taskId = task.id as string;

    // Goal-level attachment uploaded first
    await sql`
      INSERT INTO task_attachments (goal_id, filename, storage_path, mime_type, size_bytes, uploaded_at)
      VALUES (${goalId}, 'goal.pdf', '/tmp/goal.pdf', 'application/pdf', 100, '2026-04-16 09:00:00+00')
    `;
    // Task-level attachment uploaded later
    await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes, uploaded_at)
      VALUES (${taskId}, 'task.png', '/tmp/task.png', 'image/png', 200, '2026-04-16 10:00:00+00')
    `;

    const request = new Request(`http://localhost/api/tasks/${taskId}/attachments`);
    const response = await getTaskAttachments(request, {
      params: Promise.resolve({ id: taskId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].filename).toBe("goal.pdf");
    expect(body.data[0].source).toBe("goal");
    expect(body.data[1].filename).toBe("task.png");
    expect(body.data[1].source).toBe("task");
  });

  it("returns empty array for task with no attachments and no goal", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, qa_required)
      VALUES (${bizId}, 'dev-agent', 'owner', 't', 'b', false)
      RETURNING id
    `;
    const taskId = task.id as string;

    const request = new Request(`http://localhost/api/tasks/${taskId}/attachments`);
    const response = await getTaskAttachments(request, {
      params: Promise.resolve({ id: taskId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(0);
  });

  it("returns only task attachments when task has no parent goal", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, qa_required)
      VALUES (${bizId}, 'dev-agent', 'owner', 't', 'b', false)
      RETURNING id
    `;
    const taskId = task.id as string;
    await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${taskId}, 'only.txt', '/tmp/only.txt', 'text/plain', 5)
    `;

    const request = new Request(`http://localhost/api/tasks/${taskId}/attachments`);
    const response = await getTaskAttachments(request, {
      params: Promise.resolve({ id: taskId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].filename).toBe("only.txt");
    expect(body.data[0].source).toBe("task");
  });

  it("returns 404 when task does not exist", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000999";
    const request = new Request(`http://localhost/api/tasks/${fakeId}/attachments`);
    const response = await getTaskAttachments(request, {
      params: Promise.resolve({ id: fakeId }),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/goals/[id]/attachments", () => {
  it("returns goal-scoped attachments only", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${bizId}, 'g', 'g')
      RETURNING id
    `;
    const goalId = goal.id as string;

    await sql`
      INSERT INTO task_attachments (goal_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${goalId}, 'a.pdf', '/tmp/a.pdf', 'application/pdf', 50)
    `;

    const request = new Request(`http://localhost/api/goals/${goalId}/attachments`);
    const response = await getGoalAttachments(request, {
      params: Promise.resolve({ id: goalId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].filename).toBe("a.pdf");
  });

  it("returns empty for goal with no attachments", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${bizId}, 'g', 'g')
      RETURNING id
    `;
    const goalId = goal.id as string;
    const request = new Request(`http://localhost/api/goals/${goalId}/attachments`);
    const response = await getGoalAttachments(request, {
      params: Promise.resolve({ id: goalId }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(0);
  });

  it("returns 404 when goal does not exist", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000999";
    const request = new Request(`http://localhost/api/goals/${fakeId}/attachments`);
    const response = await getGoalAttachments(request, {
      params: Promise.resolve({ id: fakeId }),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/hives/[id]/ideas/[ideaId]/attachments", () => {
  it("returns idea-scoped attachments only", async () => {
    const [idea] = await sql`
      INSERT INTO hive_ideas (hive_id, title, created_by)
      VALUES (${bizId}, 'idea', 'owner')
      RETURNING id
    `;
    const ideaId = idea.id as string;

    await sql`
      INSERT INTO task_attachments (idea_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${ideaId}, 'ref.png', '/tmp/ref.png', 'image/png', 123)
    `;

    const request = new Request(`http://localhost/api/hives/${bizId}/ideas/${ideaId}/attachments`);
    const response = await getIdeaAttachments(request, {
      params: Promise.resolve({ id: bizId, ideaId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].filename).toBe("ref.png");
    expect(body.data[0].source).toBe("idea");
  });

  it("returns empty for idea with no attachments", async () => {
    const [idea] = await sql`
      INSERT INTO hive_ideas (hive_id, title, created_by)
      VALUES (${bizId}, 'idea', 'owner')
      RETURNING id
    `;
    const ideaId = idea.id as string;

    const request = new Request(`http://localhost/api/hives/${bizId}/ideas/${ideaId}/attachments`);
    const response = await getIdeaAttachments(request, {
      params: Promise.resolve({ id: bizId, ideaId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(0);
  });

  it("returns 404 when idea does not exist in the hive", async () => {
    const fakeIdeaId = "00000000-0000-0000-0000-000000000998";
    const request = new Request(`http://localhost/api/hives/${bizId}/ideas/${fakeIdeaId}/attachments`);
    const response = await getIdeaAttachments(request, {
      params: Promise.resolve({ id: bizId, ideaId: fakeIdeaId }),
    });

    expect(response.status).toBe(404);
  });
});
