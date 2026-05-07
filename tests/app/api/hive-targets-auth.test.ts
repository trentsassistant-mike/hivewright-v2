import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

// Authorization coverage for hive target mutation handlers (audit d20f7b46,
// Sprint 2). Uses the same mock pattern established in
// tests/app/api/hive-ideas.test.ts and tests/api/api-auth-guards.test.ts:
// override the requireApiUser test bypass so the per-handler authorization
// branches are reachable, and stub canAccessHive so hive-membership state
// is controllable per test.
const authState = vi.hoisted(() => ({
  isSystemOwner: true,
  canAccess: true,
}));

vi.mock("@/app/api/_lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/_lib/auth")>();
  return {
    ...actual,
    requireApiUser: async () => ({
      user: {
        id: "test-user",
        email: "test@local",
        isSystemOwner: authState.isSystemOwner,
      },
    }),
  };
});

vi.mock("@/auth/users", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/users")>();
  return {
    ...actual,
    canAccessHive: async () => authState.canAccess,
  };
});

// Imports after vi.mock so the routes bind to the mocked auth module.
import { POST as TARGETS_POST } from "@/app/api/hives/[id]/targets/route";
import {
  PATCH as TARGET_PATCH,
  DELETE as TARGET_DELETE,
} from "@/app/api/hives/[id]/targets/[targetId]/route";

async function seedHive(): Promise<string> {
  const slug = "ht-" + Math.random().toString(36).slice(2, 8);
  const [h] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type) VALUES ('T', ${slug}, 'digital') RETURNING id
  `;
  return h.id;
}

async function seedTarget(hiveId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hive_targets (hive_id, title, sort_order, status)
    VALUES (${hiveId}, 'seeded target', 0, 'open')
    RETURNING id
  `;
  return row.id;
}

function req(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("/api/hives/[id]/targets — authorization", () => {
  beforeEach(async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    await truncateAll(sql);
  });

  it("POST returns 403 when caller lacks hive access", async () => {
    authState.isSystemOwner = false;
    authState.canAccess = false;

    const id = await seedHive();
    const res = await TARGETS_POST(
      req(`http://t/api/hives/${id}/targets`, "POST", { title: "blocked" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);

    const rows = await sql`SELECT id FROM hive_targets WHERE hive_id = ${id}`;
    expect(rows.length).toBe(0);
  });

  it("POST succeeds for a non-owner member with hive access", async () => {
    authState.isSystemOwner = false;
    authState.canAccess = true;

    const id = await seedHive();
    const res = await TARGETS_POST(
      req(`http://t/api/hives/${id}/targets`, "POST", {
        title: "member-target",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe("member-target");
    expect(body.data.hiveId).toBe(id);
  });

  it("POST succeeds for a system owner (canAccessHive bypass)", async () => {
    authState.isSystemOwner = true;
    authState.canAccess = false; // would deny non-owners; owners bypass

    const id = await seedHive();
    const res = await TARGETS_POST(
      req(`http://t/api/hives/${id}/targets`, "POST", { title: "owner-target" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
  });
});

describe("/api/hives/[id]/targets/[targetId] — authorization", () => {
  beforeEach(async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    await truncateAll(sql);
  });

  it("PATCH returns 403 when caller lacks hive access and does not mutate the row", async () => {
    const id = await seedHive();
    const targetId = await seedTarget(id);

    authState.isSystemOwner = false;
    authState.canAccess = false;

    const res = await TARGET_PATCH(
      req("http://t", "PATCH", { title: "attempted-rename" }),
      { params: Promise.resolve({ id, targetId }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);

    const [row] = await sql<{ title: string }[]>`
      SELECT title FROM hive_targets WHERE id = ${targetId}
    `;
    expect(row.title).toBe("seeded target");
  });

  it("PATCH succeeds for a non-owner member with hive access", async () => {
    const id = await seedHive();
    const targetId = await seedTarget(id);

    authState.isSystemOwner = false;
    authState.canAccess = true;

    const res = await TARGET_PATCH(
      req("http://t", "PATCH", { title: "renamed" }),
      { params: Promise.resolve({ id, targetId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("renamed");
  });

  it("DELETE returns 403 when caller lacks hive access and preserves the row", async () => {
    const id = await seedHive();
    const targetId = await seedTarget(id);

    authState.isSystemOwner = false;
    authState.canAccess = false;

    const res = await TARGET_DELETE(
      req("http://t", "DELETE"),
      { params: Promise.resolve({ id, targetId }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);

    const [row] = await sql`SELECT id FROM hive_targets WHERE id = ${targetId}`;
    expect(row).toBeDefined();
  });

  it("DELETE succeeds for a non-owner member with hive access", async () => {
    const id = await seedHive();
    const targetId = await seedTarget(id);

    authState.isSystemOwner = false;
    authState.canAccess = true;

    const res = await TARGET_DELETE(
      req("http://t", "DELETE"),
      { params: Promise.resolve({ id, targetId }) },
    );
    expect(res.status).toBe(204);
    const [row] = await sql`SELECT id FROM hive_targets WHERE id = ${targetId}`;
    expect(row).toBeUndefined();
  });
});
