import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/brief/route";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

const HIVE = "dddddddd-0000-0000-0000-000000000050";

async function briefIdeas(): Promise<{ openCount: number; lastReviewAt: string | null }> {
  const res = await GET(
    new Request(`http://localhost/api/brief?hiveId=${HIVE}`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { ideas: { openCount: number; lastReviewAt: string | null } };
  };
  return body.data.ideas;
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'brief-ideas-hive', 'Brief Ideas', 'digital')
  `;
});

describe("GET /api/brief — ideas metrics", () => {
  it("returns zero open ideas and null last review when the hive has no ideas", async () => {
    await expect(briefIdeas()).resolves.toEqual({
      openCount: 0,
      lastReviewAt: null,
    });
  });

  it("returns open ideas count plus the most recent review timestamp for the hive", async () => {
    await sql`
      INSERT INTO hive_ideas (hive_id, title, created_by, status, reviewed_at)
      VALUES
        (${HIVE}::uuid, 'Open one', 'owner', 'open', NULL),
        (${HIVE}::uuid, 'Open two', 'owner', 'open', NOW() - INTERVAL '3 hours'),
        (${HIVE}::uuid, 'Reviewed', 'owner', 'reviewed', NOW() - INTERVAL '1 hour'),
        (${HIVE}::uuid, 'Promoted', 'owner', 'promoted', NOW() - INTERVAL '30 minutes')
    `;
    const [expected] = await sql<Array<{ last_reviewed_at: Date }>>`
      SELECT MAX(reviewed_at) AS last_reviewed_at
      FROM hive_ideas
      WHERE hive_id = ${HIVE}::uuid
    `;

    const ideas = await briefIdeas();
    expect(ideas.openCount).toBe(2);
    expect(ideas.lastReviewAt).toBe(expected.last_reviewed_at.toISOString());
  });

  it("never leaks idea metrics from another hive", async () => {
    const otherHive = "eeeeeeee-0000-0000-0000-000000000060";
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${otherHive}, 'brief-ideas-other', 'Brief Ideas Other', 'digital')
    `;
    await sql`
      INSERT INTO hive_ideas (hive_id, title, created_by, status, reviewed_at)
      VALUES (${otherHive}::uuid, 'Other open', 'owner', 'open', NOW())
    `;

    await expect(briefIdeas()).resolves.toEqual({
      openCount: 0,
      lastReviewAt: null,
    });
  });
});
