import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSql } = vi.hoisted(() => {
  const sql = vi.fn() as ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
  };
  sql.begin = vi.fn(async (cb: (tx: typeof sql) => Promise<void>) => cb(sql));
  return { mockSql: sql };
});

vi.mock("../../_lib/db", () => ({
  sql: mockSql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: vi.fn(),
}));

vi.mock("@/openclaw/goal-supervisor-cleanup", () => ({
  pruneGoalSupervisor: vi.fn(),
}));

import { POST as abandonGoal } from "./abandon/route";
import { POST as cancelGoal } from "./cancel/route";
import { requireApiUser } from "../../_lib/auth";
import { canMutateHive } from "@/auth/users";
import { pruneGoalSupervisor } from "@/openclaw/goal-supervisor-cleanup";

const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockPruneGoalSupervisor = pruneGoalSupervisor as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "goal-1" }) };
const goalRow = {
  id: "goal-1",
  hive_id: "hive-1",
  title: "Goal",
  status: "active",
  session_id: "hw-gs-hive-1-goal-1",
};

function lifecycleRequest(body: unknown = {}, sourceHiveId = "hive-1") {
  return new Request("http://localhost/api/goals/goal-1/cancel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HiveWright-EA-Source-Hive-Id": sourceHiveId,
      "X-HiveWright-EA-Thread-Id": "thread-1",
      "X-HiveWright-EA-Owner-Message-Id": "message-1",
      "X-HiveWright-EA-Source": "dashboard",
    },
    body: JSON.stringify(body),
  });
}

describe("goal lifecycle status endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockReset();
    mockSql.begin.mockClear();
    mockSql.begin.mockImplementation(async (cb: (tx: typeof mockSql) => Promise<void>) => cb(mockSql));
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("abandons an active goal, clears supervisor state, and writes a goal comment", async () => {
    mockSql.mockResolvedValueOnce([goalRow]);

    const res = await abandonGoal(lifecycleRequest({ reason: "duplicate goal" }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      goalId: "goal-1",
      status: "abandoned",
      previousStatus: "active",
      supervisorSessionEnded: true,
    });
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(mockPruneGoalSupervisor).toHaveBeenCalledWith(mockSql, "goal-1");
  });

  it("cancels an active goal when a reason is supplied", async () => {
    mockSql.mockResolvedValueOnce([goalRow]);

    const res = await cancelGoal(lifecycleRequest({ reason: "owner cancelled" }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("cancelled");
    expect(mockPruneGoalSupervisor).toHaveBeenCalledWith(mockSql, "goal-1");
  });

  it("requires a reason for cancellation", async () => {
    const res = await cancelGoal(lifecycleRequest({}), params);

    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown goals", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await abandonGoal(lifecycleRequest({ reason: "duplicate" }), params);

    expect(res.status).toBe(404);
  });

  it("returns 409 for terminal goals", async () => {
    mockSql.mockResolvedValueOnce([{ ...goalRow, status: "achieved" }]);

    const res = await abandonGoal(lifecycleRequest({ reason: "duplicate" }), params);

    expect(res.status).toBe(409);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await abandonGoal(lifecycleRequest({ reason: "duplicate" }), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects cross-hive EA audit headers", async () => {
    mockSql.mockResolvedValueOnce([goalRow]);

    const res = await abandonGoal(
      lifecycleRequest({ reason: "duplicate" }, "other-hive"),
      params,
    );

    expect(res.status).toBe(403);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it("rejects non-owner callers without hive mutation access", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([goalRow]);
    mockCanMutateHive.mockResolvedValueOnce(false);

    const res = await abandonGoal(lifecycleRequest({ reason: "duplicate" }), params);

    expect(res.status).toBe(403);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
  });
});
