import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

import { canAccessHive } from "@/auth/users";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { GET } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "hive-1" }) };
const targetRow = {
  id: "target-1",
  hive_id: "hive-1",
  title: "Ship secure reads",
  target_value: "All patched routes covered",
  deadline: null,
  notes: null,
  sort_order: 0,
  status: "open",
  created_at: new Date("2026-05-01T00:00:00.000Z"),
  updated_at: new Date("2026-05-01T00:00:00.000Z"),
};

describe("GET /api/hives/[id]/targets access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
  });

  it("returns 401 for signed-out callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/hives/hive-1/targets"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the requested hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1" }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/hives/hive-1/targets"), params);

    expect(res.status).toBe(403);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
  });

  it("returns 200 for a caller with access to the requested hive", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: "hive-1" }])
      .mockResolvedValueOnce([targetRow]);

    const res = await GET(new Request("http://localhost/api/hives/hive-1/targets"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "target-1",
        hiveId: "hive-1",
        title: "Ship secure reads",
      }),
    ]);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
