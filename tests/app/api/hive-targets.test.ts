import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { GET, POST } from "../../../src/app/api/hives/[id]/targets/route";
import {
  PATCH as TARGET_PATCH,
  DELETE as TARGET_DELETE,
} from "../../../src/app/api/hives/[id]/targets/[targetId]/route";

async function seedHive(): Promise<string> {
  const [h] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type) VALUES ('T', ${"ht-" + Math.random().toString(36).slice(2,8)}, 'digital') RETURNING id
  `;
  return h.id;
}

function req(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("/api/hives/[id]/targets", () => {
  beforeEach(async () => { await truncateAll(sql); });

  it("POST creates a target and returns it", async () => {
    const id = await seedHive();
    const res = await POST(
      req(`http://t/api/hives/${id}/targets`, "POST", {
        title: "MRR", target_value: "$50k/mo", deadline: "2026-12-31", notes: "ARR",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe("MRR");
    expect(body.data.hiveId).toBe(id);
    expect(body.data.sortOrder).toBe(0);
    expect(body.data.status).toBe("open");
  });

  it("POST auto-increments sort_order when omitted", async () => {
    const id = await seedHive();
    await POST(req("http://t", "POST", { title: "A" }), { params: Promise.resolve({ id }) });
    const res = await POST(req("http://t", "POST", { title: "B" }), { params: Promise.resolve({ id }) });
    const body = await res.json();
    expect(body.data.sortOrder).toBe(1);
  });

  it("POST rejects missing title", async () => {
    const id = await seedHive();
    const res = await POST(req("http://t", "POST", {}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("POST defaults status to 'open' when omitted", async () => {
    const id = await seedHive();
    const res = await POST(req("http://t", "POST", { title: "A" }), { params: Promise.resolve({ id }) });
    const body = await res.json();
    expect(body.data.status).toBe("open");
  });

  it("POST accepts status='achieved'", async () => {
    const id = await seedHive();
    const res = await POST(req("http://t", "POST", { title: "A", status: "achieved" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("achieved");
  });

  it("POST rejects invalid status", async () => {
    const id = await seedHive();
    const res = await POST(req("http://t", "POST", { title: "A", status: "bogus" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("GET returns targets ordered by sort_order", async () => {
    const id = await seedHive();
    await sql`INSERT INTO hive_targets (hive_id, title, sort_order) VALUES (${id}, 'Second', 1)`;
    await sql`INSERT INTO hive_targets (hive_id, title, sort_order) VALUES (${id}, 'First', 0)`;
    const res = await GET(req("http://t", "GET"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((t: { title: string }) => t.title)).toEqual(["First", "Second"]);
  });

  it("PATCH updates fields and bumps updated_at", async () => {
    const id = await seedHive();
    const createRes = await POST(req("http://t", "POST", { title: "Orig" }), { params: Promise.resolve({ id }) });
    const { data: created } = await createRes.json();
    const createdAt = new Date(created.updatedAt).getTime();

    // Small wait so NOW() definitively advances.
    await new Promise(r => setTimeout(r, 10));

    const res = await TARGET_PATCH(
      req("http://t", "PATCH", { title: "Renamed", target_value: "5" }),
      { params: Promise.resolve({ id, targetId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("Renamed");
    expect(body.data.targetValue).toBe("5");
    expect(new Date(body.data.updatedAt).getTime()).toBeGreaterThan(createdAt);
  });

  it("PATCH can transition status", async () => {
    const id = await seedHive();
    const createRes = await POST(req("http://t", "POST", { title: "A" }), { params: Promise.resolve({ id }) });
    const { data: created } = await createRes.json();
    const res = await TARGET_PATCH(
      req("http://t", "PATCH", { status: "achieved" }),
      { params: Promise.resolve({ id, targetId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("achieved");
  });

  it("PATCH rejects invalid status", async () => {
    const id = await seedHive();
    const createRes = await POST(req("http://t", "POST", { title: "A" }), { params: Promise.resolve({ id }) });
    const { data: created } = await createRes.json();
    const res = await TARGET_PATCH(
      req("http://t", "PATCH", { status: "nope" }),
      { params: Promise.resolve({ id, targetId: created.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 when target belongs to a different hive", async () => {
    const id1 = await seedHive();
    const id2 = await seedHive();
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO hive_targets (hive_id, title) VALUES (${id2}, 'other') RETURNING id
    `;
    const res = await TARGET_PATCH(
      req("http://t", "PATCH", { title: "x" }),
      { params: Promise.resolve({ id: id1, targetId: t.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE removes the target", async () => {
    const id = await seedHive();
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO hive_targets (hive_id, title) VALUES (${id}, 'gone') RETURNING id
    `;
    const res = await TARGET_DELETE(
      req("http://t", "DELETE"),
      { params: Promise.resolve({ id, targetId: t.id }) },
    );
    expect(res.status).toBe(204);
    const [remaining] = await sql`SELECT id FROM hive_targets WHERE id = ${t.id}`;
    expect(remaining).toBeUndefined();
  });

  it("DELETE returns 404 when target belongs to a different hive", async () => {
    const id1 = await seedHive();
    const id2 = await seedHive();
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO hive_targets (hive_id, title) VALUES (${id2}, 'other') RETURNING id
    `;
    const res = await TARGET_DELETE(
      req("http://t", "DELETE"),
      { params: Promise.resolve({ id: id1, targetId: t.id }) },
    );
    expect(res.status).toBe(404);
    const [still] = await sql`SELECT id FROM hive_targets WHERE id = ${t.id}`;
    expect(still).toBeDefined(); // target must still exist
  });
});
