import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { POST as archivePOST } from "../../src/app/api/goals/[id]/archive/route";
import { POST as unarchivePOST } from "../../src/app/api/goals/[id]/unarchive/route";

const BIZ = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`INSERT INTO hives (id, slug, name, type) VALUES (${BIZ}, 'biz', 'Biz', 'digital')`;
});

async function insertGoal(opts: { archived?: boolean } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, status, archived_at)
    VALUES (${BIZ}, 'g', 'achieved', ${opts.archived ? sql`NOW()` : null})
    RETURNING id
  `;
  return row.id;
}

describe("POST /api/goals/[id]/archive", () => {
  it("archives a goal that's not yet archived", async () => {
    const id = await insertGoal();
    const req = new Request(`http://x/api/goals/${id}/archive`, { method: "POST" });
    const res = await archivePOST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);

    const [g] = await sql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM goals WHERE id = ${id}
    `;
    expect(g.archived_at).not.toBeNull();
  });

  it("is idempotent for already-archived goals", async () => {
    const id = await insertGoal({ archived: true });
    const [{ archived_at: before }] = await sql<{ archived_at: Date }[]>`
      SELECT archived_at FROM goals WHERE id = ${id}
    `;
    const req = new Request(`http://x/api/goals/${id}/archive`, { method: "POST" });
    const res = await archivePOST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.idempotent).toBe(true);

    const [{ archived_at: after }] = await sql<{ archived_at: Date }[]>`
      SELECT archived_at FROM goals WHERE id = ${id}
    `;
    expect(after.getTime()).toBe(before.getTime()); // not overwritten
  });

  it("returns 404 for unknown goal", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const req = new Request(`http://x/api/goals/${id}/archive`, { method: "POST" });
    const res = await archivePOST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/goals/[id]/unarchive", () => {
  it("unarchives an archived goal", async () => {
    const id = await insertGoal({ archived: true });
    const req = new Request(`http://x/api/goals/${id}/unarchive`, { method: "POST" });
    const res = await unarchivePOST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);

    const [g] = await sql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM goals WHERE id = ${id}
    `;
    expect(g.archived_at).toBeNull();
  });

  it("is idempotent for non-archived goals", async () => {
    const id = await insertGoal();
    const req = new Request(`http://x/api/goals/${id}/unarchive`, { method: "POST" });
    const res = await unarchivePOST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.idempotent).toBe(true);
  });
});
