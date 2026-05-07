import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "@/app/api/brief/route";
import { GET as getGoals } from "@/app/api/goals/route";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

/**
 * /api/brief powers the main dashboard's "Goals" section. Achieved goals
 * belong on /goals (where they stay until archived) but must not appear on
 * the home page — the home feed should only show work that is still in
 * flight. The goals-page endpoint (/api/goals) is unaffected.
 */

const HIVE = "cccccccc-0000-0000-0000-000000000040";

interface BriefGoal {
  id: string;
  title: string;
  status: string;
}

async function insertGoal(title: string, status: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, status)
    VALUES (${HIVE}::uuid, ${title}, ${status})
    RETURNING id
  `;
  return row.id;
}

async function briefGoals(): Promise<BriefGoal[]> {
  const res = await GET(
    new Request(`http://localhost/api/brief?hiveId=${HIVE}`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { goals: BriefGoal[] } };
  return body.data.goals;
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'brief-achieved-hive', 'Brief Achieved', 'digital')
  `;
});

describe("GET /api/brief — dashboard goals filter", () => {
  it("includes non-achieved goals on the dashboard", async () => {
    const activeId = await insertGoal("still in flight", "active");
    const pausedId = await insertGoal("waiting for owner", "paused");
    const goals = await briefGoals();
    expect(goals.map((g) => g.id).sort()).toEqual([activeId, pausedId].sort());
    expect(goals.some((g) => g.status === "active")).toBe(true);
    expect(goals.some((g) => g.status === "paused")).toBe(true);
  });

  it("excludes achieved goals so they don't clutter the home dashboard", async () => {
    const activeId = await insertGoal("still in flight", "active");
    await insertGoal("already done", "achieved");
    const goals = await briefGoals();
    expect(goals.map((g) => g.id)).toEqual([activeId]);
    expect(goals.some((g) => g.status === "achieved")).toBe(false);
  });

  it("returns an empty goals list when the only goal is achieved", async () => {
    await insertGoal("already done", "achieved");
    const goals = await briefGoals();
    expect(goals).toEqual([]);
  });

  it("complement: the /goals page endpoint still shows achieved goals until they are archived", async () => {
    const activeId = await insertGoal("still in flight", "active");
    const achievedId = await insertGoal("already done", "achieved");
    const res = await getGoals(
      new Request(`http://localhost/api/goals?hiveId=${HIVE}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; status: string }> };
    const ids = body.data.map((g) => g.id).sort();
    expect(ids).toEqual([activeId, achievedId].sort());
    expect(body.data.some((g) => g.status === "achieved")).toBe(true);
  });

  it("hides archived achieved goals from /goals by default, but keeps them in the archived view", async () => {
    const activeId = await insertGoal("still in flight", "active");
    const achievedId = await insertGoal("already done", "achieved");
    await sql`
      UPDATE goals
      SET archived_at = NOW()
      WHERE id = ${achievedId}::uuid
    `;

    const defaultRes = await getGoals(
      new Request(`http://localhost/api/goals?hiveId=${HIVE}`),
    );
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as { data: Array<{ id: string; status: string }> };
    expect(defaultBody.data.map((g) => g.id)).toEqual([activeId]);
    expect(defaultBody.data.some((g) => g.status === "achieved")).toBe(false);

    const archivedRes = await getGoals(
      new Request(`http://localhost/api/goals?hiveId=${HIVE}&includeArchived=1`),
    );
    expect(archivedRes.status).toBe(200);
    const archivedBody = (await archivedRes.json()) as {
      data: Array<{ id: string; status: string; archivedAt: string | null }>;
    };
    const archivedIds = archivedBody.data.map((g) => g.id).sort();
    expect(archivedIds).toEqual([activeId, achievedId].sort());
    expect(
      archivedBody.data.find((g) => g.id === achievedId),
    ).toMatchObject({ status: "achieved" });
  });
});
