import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  sql: vi.fn(),
  canAccessHive: vi.fn(),
  dbSelect: vi.fn(),
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

vi.mock("@/db", () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

function mockDrizzleRows(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(rows)),
        orderBy: vi.fn(() => Promise.resolve(rows)),
      })),
    })),
  };
}

import { GET } from "./route";

const params = { params: Promise.resolve({ id: "session-1" }) };

function request() {
  return new Request("http://localhost/api/voice/sessions/session-1/events");
}

describe("GET /api/voice/sessions/[id]/events access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
  });

  it("returns 401 for signed-out callers before resolving the session hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request(), params);

    expect(res.status).toBe(401);
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the session's owning hive", async () => {
    mocks.dbSelect.mockReturnValueOnce(mockDrizzleRows([{ hiveId: "hive-1" }]));
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request(), params);

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
  });

  it("returns 200 after resolving the session's owning hive for an allowed caller", async () => {
    vi.useFakeTimers();
    mocks.dbSelect
      .mockReturnValueOnce(mockDrizzleRows([{ hiveId: "hive-1" }]))
      .mockReturnValue(mockDrizzleRows([]));

    const res = await GET(request(), params);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");

    await res.body?.cancel();
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
  });
});
