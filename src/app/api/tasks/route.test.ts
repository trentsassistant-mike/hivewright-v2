import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { unsafe: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    requireSystemOwner: vi.fn(),
    canAccessHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET } from "./route";

describe("GET /api/tasks access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.sql.unsafe.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before querying tasks", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/tasks"));

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects non-owner callers that request an inaccessible hiveId", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/tasks?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("filters broad non-owner task reads to accessible hives", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks?limit=10&offset=0"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).toHaveBeenCalledTimes(2);
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("hive_memberships");
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["member-1"]);
    expect(mocks.sql.unsafe.mock.calls[1][0]).toContain("hive_memberships");
    expect(mocks.sql.unsafe.mock.calls[1][1]).toEqual(["member-1", 10, 0]);
  });

  it("allows system-owner callers to request a hiveId without membership checks", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks?hiveId=hive-a"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["hive-a"]);
  });
});
