import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { unsafe: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET } from "./route";

describe("GET /api/goals access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.sql.unsafe.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before querying goals", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/goals"));

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects non-owner callers that request an inaccessible hiveId", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/goals?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("filters broad non-owner goal reads to accessible hives", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/goals?limit=10&offset=0"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).toHaveBeenCalledTimes(2);
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("hive_memberships");
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["member-1"]);
    expect(mocks.sql.unsafe.mock.calls[1][0]).toContain("g.hive_id IN");
    expect(mocks.sql.unsafe.mock.calls[1][1]).toEqual(["member-1", 10, 0]);
  });

  it("allows system-owner callers to request a hiveId without membership checks", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "1" }])
      .mockResolvedValueOnce([{
        id: "goal-1",
        hive_id: "hive-a",
        project_id: null,
        parent_id: null,
        title: "Goal 1",
        description: null,
        status: "paused",
        budget_cents: 1000,
        spent_cents: 1000,
        budget_state: "paused",
        budget_warning_triggered_at: new Date("2026-04-27T00:00:00Z"),
        budget_enforced_at: new Date("2026-04-27T00:10:00Z"),
        budget_enforcement_reason: "Paused by budget",
        session_id: null,
        created_at: new Date("2026-04-27T00:00:00Z"),
        updated_at: new Date("2026-04-27T00:10:00Z"),
        archived_at: null,
        total_tasks: "2",
        completed_tasks: "1",
      }]);

    const res = await GET(new Request("http://localhost/api/goals?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].budget).toMatchObject({
      capCents: 1000,
      spentCents: 1000,
      remainingCents: 0,
      percentUsed: 100,
      warning: true,
      paused: true,
      state: "paused",
      reason: "Paused by budget",
    });
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["hive-a"]);
  });

  it("allows system-owner callers to request a hiveId without membership checks", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/goals?hiveId=hive-a"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["hive-a"]);
  });
});
