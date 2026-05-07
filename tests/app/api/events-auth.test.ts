import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

const authState = vi.hoisted(() => ({
  authHeader: null as string | null,
  sessionUser: null as { id?: string | null; email?: string | null; name?: string | null } | null,
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(authState.authHeader ? { authorization: authState.authHeader } : {}),
}));

vi.mock("@/auth", () => ({
  auth: async () => (authState.sessionUser ? { user: authState.sessionUser } : null),
}));

async function loadRoute() {
  const mod = await import("@/app/api/events/route");
  return mod.GET;
}

async function readFirstFrame(response: Response) {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const chunk = await reader!.read();
  const text = new TextDecoder().decode(chunk.value);
  await reader!.cancel();
  return text;
}

beforeEach(async () => {
  await truncateAll(sql);
  authState.authHeader = null;
  authState.sessionUser = null;
  process.env.VITEST = "false";
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

afterEach(() => {
  process.env.VITEST = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

describe.sequential("GET /api/events auth guard", () => {
  it("denies unauthenticated requests with 401", async () => {
    const GET = await loadRoute();

    const response = await GET(new Request("http://localhost/api/events"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unauthorized",
    });
  });

  it("allows authenticated owner-session requests", async () => {
    authState.sessionUser = {
      id: "owner-user",
      email: "owner@hivewright.local",
      name: "Owner",
    };
    const GET = await loadRoute();
    const controller = new AbortController();

    const response = await GET(new Request("http://localhost/api/events", {
      signal: controller.signal,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(readFirstFrame(response)).resolves.toContain("\"type\":\"connected\"");
    controller.abort();
  });

  it("allows valid internal bearer requests", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "events-internal-token";
    authState.authHeader = "Bearer events-internal-token";
    const GET = await loadRoute();
    const controller = new AbortController();

    const response = await GET(new Request("http://localhost/api/events?hiveId=11111111-1111-1111-1111-111111111111", {
      signal: controller.signal,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(readFirstFrame(response)).resolves.toContain("\"type\":\"connected\"");
    controller.abort();
  });

  it("rejects authenticated non-members for requested hive streams", async () => {
    const hiveId = "33333333-3333-3333-3333-333333333333";
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${hiveId}, 'events-auth-hive', 'Events Auth Hive', 'digital')
    `;
    await sql`
      INSERT INTO users (id, email, password_hash, is_system_owner)
      VALUES ('44444444-4444-4444-4444-444444444444', 'viewer@example.com', 'x', false)
    `;
    authState.sessionUser = {
      id: "viewer-user",
      email: "viewer@example.com",
      name: "Viewer",
    };
    const GET = await loadRoute();

    const response = await GET(new Request(`http://localhost/api/events?hiveId=${hiveId}`));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Forbidden: caller cannot access this hive",
    });
  });
});
