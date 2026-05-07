import { describe, it, expect, beforeEach } from "vitest";
import { POST as createDecision } from "@/app/api/decisions/route";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as createTask } from "@/app/api/tasks/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE = "aaaaaaaa-1111-4111-8111-111111111111";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}::uuid, 'creation-pause-hive', 'Creation Pause Hive', 'digital')
  `;
  await sql`
    INSERT INTO hive_runtime_locks (hive_id, creation_paused, reason, paused_by)
    VALUES (${HIVE}::uuid, true, 'manual recovery lock', 'test')
  `;
});

function postJson(path: string, body: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectCreationPause(response: Response) {
  expect(response.status).toBe(423);
  const body = await response.json();
  expect(body.code).toBe("HIVE_CREATION_PAUSED");
  expect(body.error).toMatch(/manual recovery lock/);
}

describe("hive creation pause", () => {
  it("blocks task creation through the API", async () => {
    const res = await createTask(postJson("/api/tasks", {
      hiveId: HIVE,
      assignedTo: "dev-agent",
      title: "Should not start",
      brief: "Blocked while the hive is locked",
      createdBy: "owner",
    }));

    await expectCreationPause(res);
    const [count] = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM tasks WHERE hive_id = ${HIVE}::uuid
    `;
    expect(count.total).toBe("0");
  });

  it("blocks goal creation through the API", async () => {
    const res = await createGoal(postJson("/api/goals", {
      hiveId: HIVE,
      title: "Should not become a goal",
      description: "Blocked while the hive is locked",
    }));

    await expectCreationPause(res);
    const [count] = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM goals WHERE hive_id = ${HIVE}::uuid
    `;
    expect(count.total).toBe("0");
  });

  it("blocks decision creation through the API before blocking a task", async () => {
    await sql`
      UPDATE hive_runtime_locks SET creation_paused = false WHERE hive_id = ${HIVE}::uuid
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${HIVE}::uuid, 'dev-agent', 'test', 'Existing task', 'Existing task')
      RETURNING id
    `;
    await sql`
      UPDATE hive_runtime_locks SET creation_paused = true WHERE hive_id = ${HIVE}::uuid
    `;

    const res = await createDecision(postJson("/api/decisions", {
      hiveId: HIVE,
      taskId: task.id,
      question: "Should this proceed?",
      context: "Blocked while the hive is locked",
      options: [{ label: "No" }],
    }));

    await expectCreationPause(res);
    const [taskAfter] = await sql<{ status: string }[]>`
      SELECT status FROM tasks WHERE id = ${task.id}
    `;
    expect(taskAfter.status).toBe("pending");
  });

  it("blocks direct database inserts for escaped creation paths", async () => {
    await expect(sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${HIVE}::uuid, 'dev-agent', 'escaped-path', 'Escaped task', 'Direct DB insert')
    `).rejects.toThrow(/HIVE_CREATION_PAUSED/);

    await expect(sql`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${HIVE}::uuid, 'Escaped goal', 'Direct DB insert')
    `).rejects.toThrow(/HIVE_CREATION_PAUSED/);

    await expect(sql`
      INSERT INTO decisions (hive_id, title, context, status)
      VALUES (${HIVE}::uuid, 'Escaped decision', 'Direct DB insert', 'pending')
    `).rejects.toThrow(/HIVE_CREATION_PAUSED/);
  });

  it("blocks existing tasks from being reactivated while paused", async () => {
    await sql`
      UPDATE hive_runtime_locks SET creation_paused = false WHERE hive_id = ${HIVE}::uuid
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief)
      VALUES (${HIVE}::uuid, 'dev-agent', 'test', 'cancelled', 'Old task', 'Old task')
      RETURNING id
    `;
    await sql`
      UPDATE hive_runtime_locks SET creation_paused = true WHERE hive_id = ${HIVE}::uuid
    `;

    await expect(sql`
      UPDATE tasks SET status = 'pending' WHERE id = ${task.id}
    `).rejects.toThrow(/HIVE_CREATION_PAUSED/);

    const [taskAfter] = await sql<{ status: string }[]>`
      SELECT status FROM tasks WHERE id = ${task.id}
    `;
    expect(taskAfter.status).toBe("cancelled");
  });
});
