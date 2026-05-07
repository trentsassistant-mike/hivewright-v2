import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  loadScheduleDetail: vi.fn(),
}));

vi.mock("../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/schedules/detail", () => ({
  loadScheduleDetail: mocks.loadScheduleDetail,
}));

import { GET } from "./route";

const detail = {
  schedule: {
    id: "schedule-1",
    hiveId: "hive-1",
    cronExpression: "0 9 * * 1",
    taskTemplate: { assignedTo: "developer-agent", title: "Review", brief: "Brief" },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdBy: "goal-supervisor",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  },
  role: null,
  runHistory: [],
  inProcessRuntime: false,
};

describe("GET /api/schedules/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.loadScheduleDetail.mockResolvedValue(detail);
  });

  it("requires hive access for non-owner callers", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/schedules/schedule-1"), {
      params: Promise.resolve({ id: "schedule-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
  });

  it("returns the schedule detail when the caller can access the hive", async () => {
    const res = await GET(new Request("http://localhost/api/schedules/schedule-1"), {
      params: Promise.resolve({ id: "schedule-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.schedule.id).toBe("schedule-1");
    expect(mocks.loadScheduleDetail).toHaveBeenCalledWith(mocks.sql, "schedule-1");
  });

  it("does not call canAccessHive again for system owners", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });

    const res = await GET(new Request("http://localhost/api/schedules/schedule-1"), {
      params: Promise.resolve({ id: "schedule-1" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });
});
