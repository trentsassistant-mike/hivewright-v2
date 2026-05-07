import { describe, expect, it, beforeEach } from "vitest";
import { GET as getHiveById } from "@/app/api/hives/[id]/route";
import { GET as getHives } from "@/app/api/hives/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("GET /api/hives system fixtures", () => {
  it("hides system fixtures by default and exposes them through the ops escape hatch", async () => {
    const [regular] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('visible-hive', 'Visible Hive', 'digital')
      RETURNING id
    `;
    const [fixture] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type, is_system_fixture)
      VALUES ('owner-session-smoke', 'Owner Session Smoke', 'digital', true)
      RETURNING id
    `;

    const defaultRes = await getHives(new Request("http://localhost/api/hives"));
    expect(defaultRes.status).toBe(200);
    const defaultBody = await defaultRes.json();
    expect(defaultBody.data.map((hive: { slug: string }) => hive.slug)).toEqual(["visible-hive"]);

    const includeRes = await getHives(
      new Request("http://localhost/api/hives?includeSystemFixtures=true"),
    );
    expect(includeRes.status).toBe(200);
    const includeBody = await includeRes.json();
    expect(includeBody.data.map((hive: { slug: string }) => hive.slug).sort()).toEqual([
      "owner-session-smoke",
      "visible-hive",
    ]);

    const byIdRes = await getHiveById(new Request("http://localhost/api/hives/fixture"), {
      params: Promise.resolve({ id: fixture.id }),
    });
    expect(byIdRes.status).toBe(200);
    const byIdBody = await byIdRes.json();
    expect(byIdBody.data).toMatchObject({
      id: fixture.id,
      slug: "owner-session-smoke",
      isSystemFixture: true,
    });
    expect(regular.id).toBeDefined();
  });
});
