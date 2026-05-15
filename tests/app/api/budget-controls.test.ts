import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { GET, PUT } from "../../../src/app/api/budget-controls/route";

let hiveSeq = 0;

async function seedHive(): Promise<string> {
  hiveSeq += 1;
  const [h] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type)
    VALUES (${`Budget Hive ${hiveSeq}`}, ${`budget-hive-${hiveSeq}`}, 'digital')
    RETURNING id
  `;
  return h.id;
}

function put(body: unknown): Request {
  return new Request("http://t/api/budget-controls", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/budget-controls", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("sets hive overall budget and mirrors it to the owner brief budget settings", async () => {
    const hiveId = await seedHive();

    const res = await PUT(put({
      hiveId,
      scope: "hive",
      capCents: 25_000,
      window: "weekly",
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      hiveId,
      scope: "hive",
      scopeId: null,
      capCents: 25_000,
      window: "weekly",
    });

    const [hive] = await sql`SELECT ai_budget_cap_cents, ai_budget_window FROM hives WHERE id = ${hiveId}`;
    expect(hive.ai_budget_cap_cents).toBe(25_000);
    expect(hive.ai_budget_window).toBe("weekly");
  });

  it("sets outcome, goal, and task budget controls scoped under the same hive", async () => {
    const hiveId = await seedHive();
    const [target] = await sql<{ id: string }[]>`
      INSERT INTO hive_targets (hive_id, title, target_value)
      VALUES (${hiveId}, 'Outcome', '1000')
      RETURNING id
    `;
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${hiveId}, 'Goal', 'Goal budget test')
      RETURNING id
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, title, brief, status, assigned_to, created_by)
      VALUES (${hiveId}, 'Task', 'Task budget test', 'pending', 'dev-agent', 'test')
      RETURNING id
    `;

    for (const [scope, scopeId, capCents] of [
      ["outcome", target.id, 5_000],
      ["goal", goal.id, 3_000],
      ["task", task.id, 1_000],
    ] as const) {
      const res = await PUT(put({ hiveId, scope, scopeId, capCents, window: "monthly" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toMatchObject({ hiveId, scope, scopeId, capCents, window: "monthly" });
    }

    const list = await GET(new Request(`http://t/api/budget-controls?hiveId=${hiveId}`));
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.data).toHaveLength(3);
    expect(body.data.map((row: { scope: string }) => row.scope).sort()).toEqual(["goal", "outcome", "task"]);
  });

  it("rejects scoped budgets when the target entity does not belong to the hive", async () => {
    const hiveId = await seedHive();
    const otherHiveId = await seedHive();
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${otherHiveId}, 'Other Goal', 'Wrong hive')
      RETURNING id
    `;

    const res = await PUT(put({ hiveId, scope: "goal", scopeId: goal.id, capCents: 3_000 }));
    expect(res.status).toBe(400);
  });
});
