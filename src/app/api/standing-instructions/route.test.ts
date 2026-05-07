import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
  return {
    sql,
    requireApiAuth: vi.fn(),
    requireApiUser: vi.fn(),
    requireSystemOwner: vi.fn(),
    canAccessHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET, POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/standing-instructions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function getRequest(query = "?hiveId=hive-1") {
  return new Request(`http://localhost/api/standing-instructions${query}`);
}

describe("GET /api/standing-instructions access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([]);
  });

  it("returns 401 for signed-out callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(getRequest());

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("returns 200 when the signed-in caller can access the hive", async () => {
    const res = await GET(getRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/standing-instructions owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("preserves unauthenticated denial before the owner gate", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(request({
      hiveId: "hive-1",
      content: "Escalate stale critical goals.",
      affectedDepartments: ["engineering"],
    }));

    expect(res.status).toBe(401);
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before creating standing instructions", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await POST(request({
      hiveId: "hive-1",
      content: "Escalate stale critical goals.",
      affectedDepartments: ["engineering"],
    }));

    expect(res.status).toBe(403);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows system owners to create standing instructions", async () => {
    const createdAt = new Date("2026-04-27T00:00:00.000Z");
    mocks.sql.mockResolvedValueOnce([
      {
        id: "instruction-1",
        content: "Escalate stale critical goals.",
        affected_departments: ["engineering"],
        created_at: createdAt,
      },
    ]);

    const res = await POST(request({
      hiveId: "hive-1",
      content: "Escalate stale critical goals.",
      affectedDepartments: ["engineering"],
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toEqual({
      id: "instruction-1",
      content: "Escalate stale critical goals.",
      affectedDepartments: ["engineering"],
      createdAt: createdAt.toISOString(),
    });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.sql.json).toHaveBeenCalledWith(["engineering"]);
  });
});
