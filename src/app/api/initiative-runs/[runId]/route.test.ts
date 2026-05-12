import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { createGetInitiativeRunDetailHandler } from "./get-handler";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";

function request() {
  return new Request(
    `http://localhost/api/initiative-runs/${RUN_ID}?hiveId=${HIVE_ID}`,
  );
}

function context() {
  return { params: Promise.resolve({ runId: RUN_ID }) };
}

describe("GET /api/initiative-runs/[runId] access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
  });

  it("returns 401 for signed-out callers", async () => {
    const db = vi.fn();
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await createGetInitiativeRunDetailHandler(db as never)(
      request(),
      context(),
    );

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the hive", async () => {
    const db = vi.fn();
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await createGetInitiativeRunDetailHandler(db as never)(
      request(),
      context(),
    );

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(db, "user-1", HIVE_ID);
    expect(db).not.toHaveBeenCalled();
  });

  it("returns 200 when the signed-in caller can access the hive", async () => {
    const startedAt = new Date("2026-05-01T00:00:00.000Z");
    const db = vi.fn()
      .mockResolvedValueOnce([
        {
          id: RUN_ID,
          hive_id: HIVE_ID,
          trigger_type: "manual",
          trigger_ref: null,
          status: "completed",
          started_at: startedAt,
          completed_at: startedAt,
          evaluated_candidates: 0,
          created_count: 0,
          created_goals: 0,
          created_tasks: 0,
          created_decisions: 0,
          suppressed_count: 0,
          noop_count: 0,
          suppression_reasons: {},
          run_failures: 0,
          failure_reason: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const res = await createGetInitiativeRunDetailHandler(db as never)(
      request(),
      context(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.run).toMatchObject({
      id: RUN_ID,
      runId: RUN_ID,
      hiveId: HIVE_ID,
      decisions: [],
    });
    expect(mocks.canAccessHive).toHaveBeenCalledWith(db, "user-1", HIVE_ID);
    expect(db).toHaveBeenCalledTimes(2);
  });
});
