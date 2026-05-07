import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  loadScheduleDetail: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/schedules/detail", () => ({
  loadScheduleDetail: mocks.loadScheduleDetail,
}));

import { loadScheduleDetailForPage } from "./page";

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

describe("loadScheduleDetailForPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.loadScheduleDetail.mockResolvedValue(detail);
  });

  it("loads schedule detail in-process instead of self-fetching through the request host", async () => {
    const result = await loadScheduleDetailForPage("schedule-1");

    expect(result).toBe(detail);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.loadScheduleDetail).toHaveBeenCalledWith(mocks.sql, "schedule-1");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
  });

  it("returns null when a non-owner cannot access the schedule hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    await expect(loadScheduleDetailForPage("schedule-1")).resolves.toBeNull();
  });

  it("does not require a hive membership lookup for system owners", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });

    const result = await loadScheduleDetailForPage("schedule-1");

    expect(result).toBe(detail);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });
});
