import { describe, it, expect, beforeEach } from "vitest";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as createTask } from "@/app/api/tasks/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('idem-hive', 'Idempotency Hive', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
});

function postJson(path: "/api/goals" | "/api/tasks", body: unknown, key?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (key) headers.set("Idempotency-Key", key);
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response) {
  return await response.json() as { data?: { id: string }; error?: string };
}

describe("POST /api/goals idempotency", () => {
  it("returns the original response for the same key and body without creating another goal", async () => {
    const key = "goal-create-same-body";
    const body = { hiveId, title: "Deduped goal", description: "same body" };

    const first = await createGoal(postJson("/api/goals", body, key));
    const second = await createGoal(postJson("/api/goals", body, key));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await responseJson(first);
    const secondBody = await responseJson(second);
    expect(secondBody).toEqual(firstBody);

    const [count] = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM goals WHERE title = 'Deduped goal'
    `;
    expect(count.total).toBe("1");
  });

  it("returns 409 when the same key is reused with a different body", async () => {
    const key = "goal-create-different-body";
    await createGoal(postJson("/api/goals", { hiveId, title: "First goal" }, key));

    const conflict = await createGoal(postJson("/api/goals", { hiveId, title: "Second goal" }, key));

    expect(conflict.status).toBe(409);
    expect((await responseJson(conflict)).error).toMatch(/different request body/i);
    const [count] = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM goals WHERE hive_id = ${hiveId}
    `;
    expect(count.total).toBe("1");
  });

  it("creates normally when Idempotency-Key is absent", async () => {
    const body = { hiveId, title: "No key goal" };

    const first = await createGoal(postJson("/api/goals", body));
    const second = await createGoal(postJson("/api/goals", body));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await responseJson(first)).data?.id).not.toBe((await responseJson(second)).data?.id);
  });

  it("treats an expired key as reusable and creates a new goal", async () => {
    const key = "goal-create-expired";
    const body = { hiveId, title: "Expired key goal" };
    const first = await createGoal(postJson("/api/goals", body, key));
    const firstId = (await responseJson(first)).data?.id;

    await sql`
      UPDATE idempotency_keys
      SET created_at = NOW() - INTERVAL '11 minutes'
      WHERE hive_id = ${hiveId} AND route = '/api/goals' AND key = ${key}
    `;

    const second = await createGoal(postJson("/api/goals", body, key));
    const secondId = (await responseJson(second)).data?.id;

    expect(second.status).toBe(201);
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    const [count] = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM goals WHERE title = 'Expired key goal'
    `;
    expect(count.total).toBe("2");
  });

  it("scopes the same key independently across hives", async () => {
    const [otherHive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('idem-hive-two', 'Idempotency Hive Two', 'digital')
      RETURNING id
    `;
    const key = "cross-hive-key";

    const first = await createGoal(postJson("/api/goals", { hiveId, title: "Cross hive one" }, key));
    const second = await createGoal(postJson("/api/goals", { hiveId: otherHive.id, title: "Cross hive two" }, key));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await responseJson(first)).data?.id).not.toBe((await responseJson(second)).data?.id);
  });
});

describe("POST /api/tasks idempotency", () => {
  function taskBody(overrides: Record<string, unknown> = {}) {
    return {
      hiveId,
      assignedTo: "dev-agent",
      title: "Idempotent task",
      brief: "Create a task through the idempotency path",
      createdBy: "owner",
      ...overrides,
    };
  }

  it("dedupes repeated task creates with the same key and body", async () => {
    const key = "task-create-same-body";
    const body = taskBody({ title: "Deduped task", brief: "Create only one row" });

    const first = await createTask(postJson("/api/tasks", body, key));
    const second = await createTask(postJson("/api/tasks", body, key));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await responseJson(second)).toEqual(await responseJson(first));
    const [count] = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM tasks WHERE title = 'Deduped task'
    `;
    expect(count.total).toBe("1");
  });

  it("rejects task creates that reuse a key with a different body", async () => {
    const key = "task-create-different-body";
    await createTask(postJson("/api/tasks", taskBody({ title: "First task", brief: "first" }), key));

    const conflict = await createTask(postJson("/api/tasks", taskBody({ title: "Second task", brief: "second" }), key));

    expect(conflict.status).toBe(409);
    expect((await responseJson(conflict)).error).toMatch(/different request body/i);
  });

  it("creates normally when Idempotency-Key is absent", async () => {
    const body = taskBody({ title: "No key task" });

    const first = await createTask(postJson("/api/tasks", body));
    const second = await createTask(postJson("/api/tasks", body));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await responseJson(first)).data?.id).not.toBe((await responseJson(second)).data?.id);
  });

  it("treats an expired key as reusable and creates a new task", async () => {
    const key = "task-create-expired";
    const body = taskBody({ title: "Expired key task" });
    const first = await createTask(postJson("/api/tasks", body, key));
    const firstId = (await responseJson(first)).data?.id;

    await sql`
      UPDATE idempotency_keys
      SET created_at = NOW() - INTERVAL '11 minutes'
      WHERE hive_id = ${hiveId} AND route = '/api/tasks' AND key = ${key}
    `;

    const second = await createTask(postJson("/api/tasks", body, key));
    const secondId = (await responseJson(second)).data?.id;

    expect(second.status).toBe(201);
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    const [count] = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM tasks WHERE title = 'Expired key task'
    `;
    expect(count.total).toBe("2");
  });

  it("scopes the same task key independently across hives", async () => {
    const [otherHive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('idem-task-hive-two', 'Task Idempotency Hive Two', 'digital')
      RETURNING id
    `;
    const key = "task-cross-hive-key";

    const first = await createTask(postJson("/api/tasks", taskBody({ title: "Task cross hive one" }), key));
    const second = await createTask(postJson("/api/tasks", taskBody({
      hiveId: otherHive.id,
      title: "Task cross hive two",
    }), key));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await responseJson(first)).data?.id).not.toBe((await responseJson(second)).data?.id);
  });
});
