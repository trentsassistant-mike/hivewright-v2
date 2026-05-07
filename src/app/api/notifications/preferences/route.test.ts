import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

import { canAccessHive } from "@/auth/users";
import { requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { GET } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const preferenceRow = {
  id: "pref-1",
  hive_id: "hive-1",
  channel: "email",
  config: { address: "owner@example.com" },
  priority_filter: "high",
  enabled: true,
  created_at: new Date("2026-05-01T00:00:00.000Z"),
};

function request() {
  return new Request("http://localhost/api/notifications/preferences?hiveId=hive-1");
}

describe("GET /api/notifications/preferences access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
  });

  it("returns 401 for signed-out callers before parsing hive data", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the requested hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1" }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
  });

  it("returns 200 for a caller with access to the requested hive", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: "hive-1" }])
      .mockResolvedValueOnce([preferenceRow]);

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "pref-1",
        hiveId: "hive-1",
        channel: "email",
      }),
    ]);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
