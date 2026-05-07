import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createWork } from "@/app/api/work/route";
import { POST as createTask } from "@/app/api/tasks/route";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as createDecision } from "@/app/api/decisions/route";
import { POST as createHiveMemory } from "@/app/api/memory/hive/route";
import { POST as createSkillDraft } from "@/app/api/skill-drafts/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const authState = vi.hoisted(() => ({
  authHeader: null as string | null,
  taskId: null as string | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    const headers = new Headers();
    if (authState.authHeader) headers.set("authorization", authState.authHeader);
    if (authState.taskId !== null) headers.set("x-hivewright-task-id", authState.taskId);
    return headers;
  },
}));

const INTERNAL_TOKEN = "scoped-agent-token";

let hiveA: string;
let hiveB: string;
let scopedTaskId: string;
let hiveBTaskId: string;
let eaThreadId: string;
let eaOwnerMessageId: string;

function jsonRequest(path: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seedFixtures() {
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES
      ('dev-agent', 'Dev Agent', 'executor', 'claude-code'),
      ('qa', 'QA', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [a] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('scoped-write-a', 'Scoped Write A', 'digital')
    RETURNING id
  `;
  const [b] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('scoped-write-b', 'Scoped Write B', 'digital')
    RETURNING id
  `;
  hiveA = a.id;
  hiveB = b.id;

  const [taskA] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
    VALUES (${hiveA}, 'dev-agent', 'system', 'Scoped caller', 'Caller task')
    RETURNING id
  `;
  scopedTaskId = taskA.id;

  const [taskB] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
    VALUES (${hiveB}, 'dev-agent', 'system', 'Target task', 'Target task')
    RETURNING id
  `;
  hiveBTaskId = taskB.id;

  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO ea_threads (hive_id, channel_id)
    VALUES (${hiveA}, ${`dashboard:${hiveA}`})
    RETURNING id
  `;
  eaThreadId = thread.id;

  const [message] = await sql<{ id: string }[]>`
    INSERT INTO ea_messages (thread_id, role, content, source)
    VALUES (${eaThreadId}, 'owner', 'Create this in another hive', 'dashboard')
    RETURNING id
  `;
  eaOwnerMessageId = message.id;
}

async function expectScopedCrossHiveRejected(
  name: string,
  call: () => Promise<Response>,
) {
  const response = await call();
  expect(response.status, name).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    error: "Forbidden: task scope cannot write to this hive",
  });
}

describe.sequential("scoped internal task writes", () => {
  beforeEach(async () => {
    authState.authHeader = `Bearer ${INTERNAL_TOKEN}`;
    authState.taskId = null;
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;

    await truncateAll(sql);
    await seedFixtures();
    authState.taskId = scopedTaskId;
  });

  afterEach(() => {
    process.env.VITEST = "true";
    delete process.env.INTERNAL_SERVICE_TOKEN;
    authState.authHeader = null;
    authState.taskId = null;
  });

  it("rejects task-scoped cross-hive writes on covered hiveId endpoints", async () => {
    await expectScopedCrossHiveRejected("work", () =>
      createWork(jsonRequest("/api/work", {
        hiveId: hiveB,
        assignedTo: "dev-agent",
        input: "Create work in the wrong hive.",
      })),
    );
    await expectScopedCrossHiveRejected("tasks", () =>
      createTask(jsonRequest("/api/tasks", {
        hiveId: hiveB,
        assignedTo: "dev-agent",
        title: "Wrong hive task",
        brief: "This should be rejected.",
      })),
    );
    await expectScopedCrossHiveRejected("goals", () =>
      createGoal(jsonRequest("/api/goals", {
        hiveId: hiveB,
        title: "Wrong hive goal",
      })),
    );
    await expectScopedCrossHiveRejected("decisions", () =>
      createDecision(jsonRequest("/api/decisions", {
        hiveId: hiveB,
        taskId: hiveBTaskId,
        question: "Should this proceed?",
        context: "Cross-hive scoped caller.",
        options: [],
      })),
    );
    await expectScopedCrossHiveRejected("hive memory", () =>
      createHiveMemory(jsonRequest("/api/memory/hive", {
        hiveId: hiveB,
        content: "Wrong hive memory.",
      })),
    );
    await expectScopedCrossHiveRejected("skill drafts", () =>
      createSkillDraft(jsonRequest("/api/skill-drafts", {
        hiveId: hiveB,
        roleSlug: "dev-agent",
        slug: "wrong-hive-skill",
        content: "Do the thing.",
        scope: "hive",
      })),
    );
  });

  it("allows a task-scoped write to the calling task hive", async () => {
    const response = await createWork(jsonRequest("/api/work", {
      hiveId: hiveA,
      assignedTo: "dev-agent",
      input: "Create work in the scoped task hive.",
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({ type: "task" });

    const [task] = await sql<{ hive_id: string }[]>`
      SELECT hive_id FROM tasks WHERE id = ${body.data.id}
    `;
    expect(task.hive_id).toBe(hiveA);
  });

  it("preserves unscoped internal-token compatibility for cross-hive EA-style writes", async () => {
    authState.taskId = null;

    const response = await createWork(jsonRequest("/api/work", {
      hiveId: hiveB,
      assignedTo: "dev-agent",
      input: "Create unscoped EA work across hives.",
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    const [task] = await sql<{ hive_id: string }[]>`
      SELECT hive_id FROM tasks WHERE id = ${body.data.id}
    `;
    expect(task.hive_id).toBe(hiveB);
  });

  it("records one audit row for a successful EA-origin cross-hive write", async () => {
    authState.taskId = null;
    const response = await createWork(jsonRequest(
      "/api/work",
      {
        hiveId: hiveB,
        assignedTo: "dev-agent",
        input: "Create audited EA work across hives.",
      },
      {
        "X-HiveWright-EA-Source-Hive-Id": hiveA,
        "X-HiveWright-EA-Thread-Id": eaThreadId,
        "X-HiveWright-EA-Owner-Message-Id": eaOwnerMessageId,
        "X-HiveWright-EA-Source": "dashboard",
      },
    ));

    expect(response.status).toBe(201);
    const body = await response.json();
    const rows = await sql<{
      from_hive_id: string;
      to_hive_id: string;
      ea_thread_id: string | null;
      owner_message_id: string | null;
      source: string;
      request_path: string;
      request_method: string;
      created_resource_type: string | null;
      created_resource_id: string | null;
    }[]>`
      SELECT from_hive_id, to_hive_id, ea_thread_id, owner_message_id,
             source, request_path, request_method, created_resource_type,
             created_resource_id
      FROM ea_hive_switch_audit
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      from_hive_id: hiveA,
      to_hive_id: hiveB,
      ea_thread_id: eaThreadId,
      owner_message_id: eaOwnerMessageId,
      source: "dashboard",
      request_path: "/api/work",
      request_method: "POST",
      created_resource_type: "task",
      created_resource_id: body.data.id,
    });
  });
});
