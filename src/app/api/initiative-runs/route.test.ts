import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { createGetInitiativeRunsHandler } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";

function request() {
  return new Request(`http://localhost/api/initiative-runs?hiveId=${HIVE_ID}`);
}

describe("GET /api/initiative-runs access control", () => {
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

    const res = await createGetInitiativeRunsHandler(db as never)(request());

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the hive", async () => {
    const db = vi.fn();
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await createGetInitiativeRunsHandler(db as never)(request());

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(db, "user-1", HIVE_ID);
    expect(db).not.toHaveBeenCalled();
  });

  it("returns 200 when the signed-in caller can access the hive", async () => {
    const db = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await createGetInitiativeRunsHandler(db as never)(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      summary: {
        windowHours: 168,
        runCount: 0,
      },
      runs: [],
    });
    expect(mocks.canAccessHive).toHaveBeenCalledWith(db, "user-1", HIVE_ID);
    expect(db).toHaveBeenCalledTimes(2);
  });
});
