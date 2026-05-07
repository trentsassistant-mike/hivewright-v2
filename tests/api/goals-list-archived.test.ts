import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { GET } from "../../src/app/api/goals/route";

const BIZ = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`INSERT INTO hives (id, slug, name, type) VALUES (${BIZ}, 'biz', 'Biz', 'digital')`;
  await sql`
    INSERT INTO goals (hive_id, title, status, archived_at)
    VALUES
      (${BIZ}, 'visible', 'active', NULL),
      (${BIZ}, 'hidden', 'cancelled', NOW())
  `;
});

describe("GET /api/goals — archived filter", () => {
  it("excludes archived goals by default", async () => {
    const req = new Request(`http://x/api/goals?hiveId=${BIZ}`);
    const res = await GET(req);
    const body = await res.json();
    expect(body.data.map((g: { title: string }) => g.title)).toEqual(["visible"]);
  });

  it("includes archived goals when includeArchived=1", async () => {
    const req = new Request(`http://x/api/goals?hiveId=${BIZ}&includeArchived=1`);
    const res = await GET(req);
    const body = await res.json();
    const titles = body.data.map((g: { title: string }) => g.title).sort();
    expect(titles).toEqual(["hidden", "visible"]);
  });
});
