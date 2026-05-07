import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { GET, PATCH } from "../../../src/app/api/hives/[id]/route";

async function seedHive(): Promise<string> {
  const [h] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, description, mission)
    VALUES ('Orig', 'orig', 'digital', 'old desc', null)
    RETURNING id
  `;
  return h.id;
}

function req(body: unknown): Request {
  return new Request("http://t/api/hives/xxx", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/hives/[id]", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("updates mission, description, and name", async () => {
    const id = await seedHive();
    const res = await PATCH(req({
      name: "New Name",
      description: "New tagline",
      mission: "# Mission\n\nChange the world.",
    }), { params: Promise.resolve({ id }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("New Name");
    expect(body.data.description).toBe("New tagline");
    expect(body.data.mission).toContain("Change the world.");

    const [row] = await sql`SELECT name, description, mission FROM hives WHERE id = ${id}`;
    expect(row.name).toBe("New Name");
    expect(row.mission).toContain("Change the world.");
  });

  it("rejects slug update", async () => {
    const id = await seedHive();
    const res = await PATCH(req({ slug: "new-slug" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("rejects type update", async () => {
    const id = await seedHive();
    const res = await PATCH(req({ type: "physical" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("rejects empty name", async () => {
    const id = await seedHive();
    const res = await PATCH(req({ name: "" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown id", async () => {
    const res = await PATCH(req({ mission: "x" }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(res.status).toBe(404);
  });

  it("accepts a partial update (mission only)", async () => {
    const id = await seedHive();
    const res = await PATCH(req({ mission: "just mission" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const [row] = await sql`SELECT name, mission FROM hives WHERE id = ${id}`;
    expect(row.name).toBe("Orig");
    expect(row.mission).toBe("just mission");
  });

  it("GET returns the hive row including mission", async () => {
    const id = await seedHive();
    await PATCH(req({ mission: "our purpose" }), { params: Promise.resolve({ id }) });
    const res = await GET(new Request("http://t/api/hives/x"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.mission).toBe("our purpose");
  });

  it("GET returns 404 for unknown id", async () => {
    const res = await GET(
      new Request("http://t/api/hives/x"),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it.each([
    ["id", "new-id"],
    ["createdAt", "2026-01-01"],
    ["eaSessionId", "session-x"],
    ["workspacePath", "/other/path"],
  ])("rejects %s update", async (field, value) => {
    const id = await seedHive();
    const res = await PATCH(req({ [field]: value }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });
});
