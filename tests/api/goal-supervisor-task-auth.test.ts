import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as createTask } from "@/app/api/tasks/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const authState = vi.hoisted(() => ({
  authHeader: null as string | null,
  taskScopeHeader: null as string | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    const headers = new Headers();
    if (authState.authHeader) headers.set("authorization", authState.authHeader);
    if (authState.taskScopeHeader) headers.set("x-hivewright-task-id", authState.taskScopeHeader);
    return headers;
  },
}));

vi.mock("@/auth", () => ({
  auth: async () => null,
}));

const INTERNAL_TOKEN = "goal-supervisor-task-auth-token";
const TARGET_SESSION = "gs-task-auth-target-session";
const PREFIX = "gs-task-auth-";

let hiveId: string;
let otherHiveId: string;
let goalId: string;
let unrelatedTaskId: string;

function makeSupervisorTaskRequest(headers?: Record<string, string>) {
  return new Request("http://localhost:3000/api/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify({
      hiveId,
      assignedTo: "dev-agent",
      title: `${PREFIX}created task`,
      brief: "Create bounded work for the goal",
      goalId,
      sprintNumber: 1,
      qaRequired: true,
      createdBy: "goal-supervisor",
    }),
  });
}

beforeEach(async () => {
  process.env.VITEST = "false";
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
  authState.authHeader = `Bearer ${INTERNAL_TOKEN}`;
  authState.taskScopeHeader = null;

  await truncateAll(sql);

  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${`${PREFIX}target`}, 'Goal Supervisor Task Auth Target', 'digital')
    RETURNING id
  `;
  hiveId = hive.id as string;

  const [otherHive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${`${PREFIX}other`}, 'Goal Supervisor Task Auth Other', 'digital')
    RETURNING id
  `;
  otherHiveId = otherHive.id as string;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, session_id)
    VALUES (${hiveId}, 'Goal supervisor task auth goal', 'active', ${TARGET_SESSION})
    RETURNING id
  `;
  goalId = goal.id as string;

  const [unrelatedTask] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
    VALUES (${otherHiveId}, 'dev-agent', 'dispatcher', 'unrelated parent scope', 'wrong hive scope')
    RETURNING id
  `;
  unrelatedTaskId = unrelatedTask.id as string;
});

afterEach(() => {
  process.env.VITEST = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
  authState.authHeader = null;
  authState.taskScopeHeader = null;
});

describe("POST /api/tasks — goal-supervisor session proof", () => {
  it("rejects internal service goal-supervisor task creates without supervisor session proof", async () => {
    const res = await createTask(makeSupervisorTaskRequest());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/supervisor session/i);

    const rows = await sql`
      SELECT id FROM tasks WHERE goal_id = ${goalId} AND created_by = 'goal-supervisor'
    `;
    expect(rows).toHaveLength(0);
  });

  it("rejects internal service goal-supervisor task creates with mismatched supervisor session proof", async () => {
    const res = await createTask(makeSupervisorTaskRequest({ "X-Supervisor-Session": "gs-wrong-session" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/supervisor session/i);

    const rows = await sql`
      SELECT id FROM tasks WHERE goal_id = ${goalId} AND created_by = 'goal-supervisor'
    `;
    expect(rows).toHaveLength(0);
  });

  it("allows internal service goal-supervisor task creates with matching supervisor session proof", async () => {
    const res = await createTask(makeSupervisorTaskRequest({ "X-Supervisor-Session": TARGET_SESSION }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.goalId).toBe(goalId);
    expect(body.data.createdBy).toBe("goal-supervisor");
  });

  it("still rejects an unrelated inherited task scope if it reaches the route", async () => {
    authState.taskScopeHeader = unrelatedTaskId;

    const res = await createTask(makeSupervisorTaskRequest({ "X-Supervisor-Session": TARGET_SESSION }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/task scope cannot write to this hive/i);
  });
});
