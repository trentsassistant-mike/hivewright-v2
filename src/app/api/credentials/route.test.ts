import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiAuth: vi.fn(),
  requireSystemOwner: vi.fn(),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/credentials/manager", () => ({
  storeCredential: vi.fn(),
}));

import { GET } from "./route";

describe("GET /api/credentials access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.sql.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before querying credentials", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await GET(new Request("http://localhost/api/credentials"));

    expect(res.status).toBe(401);
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before querying credentials", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await GET(new Request("http://localhost/api/credentials"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/system owner/i);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows system owners and returns only existing credential metadata fields", async () => {
    mocks.sql.mockResolvedValueOnce([
      {
        id: "cred-1",
        hive_id: "hive-1",
        name: "OpenRouter",
        key: "OPENROUTER_API_KEY",
        roles_allowed: ["dev-agent"],
        expires_at: null,
        created_at: "2026-04-27T00:00:00.000Z",
        value: "must-not-leak",
      },
    ]);

    const res = await GET(new Request("http://localhost/api/credentials?hiveId=hive-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      {
        id: "cred-1",
        hiveId: "hive-1",
        name: "OpenRouter",
        key: "OPENROUTER_API_KEY",
        rolesAllowed: ["dev-agent"],
        expiresAt: null,
        createdAt: "2026-04-27T00:00:00.000Z",
      },
    ]);
    expect(body.data[0]).not.toHaveProperty("value");
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("preserves trusted internal callers accepted by the system-owner helper", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      user: {
        id: "internal-service-account",
        email: "service@hivewright.local",
        isSystemOwner: true,
      },
    });

    const res = await GET(new Request("http://localhost/api/credentials"));

    expect(res.status).toBe(200);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
});
