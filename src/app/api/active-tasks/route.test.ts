import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET, isTaskLiveBlocking, isDecisionLiveBlocking } from "./route";

describe("operations-map live-critical filtering", () => {
  it("flags critical tasks under no goal as live-blocking (direct work)", () => {
    expect(isTaskLiveBlocking("failed", null)).toBe(true);
    expect(isTaskLiveBlocking("blocked", null)).toBe(true);
    expect(isTaskLiveBlocking("unresolvable", null)).toBe(true);
  });
  it("flags critical tasks under active goals as live-blocking", () => {
    expect(isTaskLiveBlocking("failed", "active")).toBe(true);
    expect(isTaskLiveBlocking("blocked", "active")).toBe(true);
  });
  it("does NOT flag failures under achieved/cancelled/abandoned/completed goals", () => {
    expect(isTaskLiveBlocking("failed", "achieved")).toBe(false);
    expect(isTaskLiveBlocking("failed", "completed")).toBe(false);
    expect(isTaskLiveBlocking("failed", "cancelled")).toBe(false);
    expect(isTaskLiveBlocking("failed", "abandoned")).toBe(false);
    expect(isTaskLiveBlocking("unresolvable", "achieved")).toBe(false);
  });
  it("ignores non-critical task statuses entirely", () => {
    expect(isTaskLiveBlocking("active", "active")).toBe(false);
    expect(isTaskLiveBlocking("completed", "active")).toBe(false);
  });
  it("flags decisions under live or no goals only", () => {
    expect(isDecisionLiveBlocking(null)).toBe(true);
    expect(isDecisionLiveBlocking("active")).toBe(true);
    expect(isDecisionLiveBlocking("achieved")).toBe(false);
    expect(isDecisionLiveBlocking("cancelled")).toBe(false);
  });
});

describe("GET /api/active-tasks access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.sql.mockResolvedValue([]);
  });

  it("rejects authenticated non-members before querying active tasks", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request(
      "http://localhost/api/active-tasks?hiveId=11111111-1111-1111-1111-111111111111",
    ));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(
      mocks.sql,
      "user-1",
      "11111111-1111-1111-1111-111111111111",
    );
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
