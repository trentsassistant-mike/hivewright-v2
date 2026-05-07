import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  loadQualityControlsConfig: vi.fn(),
  listRoleQualityScores: vi.fn(),
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

vi.mock("@/quality/quality-config", () => ({
  applicableQualityFloor: vi.fn(() => 0.8),
  loadQualityControlsConfig: mocks.loadQualityControlsConfig,
}));

vi.mock("@/quality/score", () => ({
  listRoleQualityScores: mocks.listRoleQualityScores,
}));

import { GET } from "./route";

function request() {
  return new Request("http://localhost/api/quality/roles?hiveId=hive-1");
}

describe("GET /api/quality/roles access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.loadQualityControlsConfig.mockResolvedValue({
      defaultQualityFloor: 0.7,
      roleQualityFloors: {},
    });
    mocks.listRoleQualityScores.mockResolvedValue([]);
    mocks.sql.mockResolvedValue([]);
  });

  it("returns 401 for signed-out callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.loadQualityControlsConfig).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.loadQualityControlsConfig).not.toHaveBeenCalled();
  });

  it("returns 200 when the signed-in caller can access the hive", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      defaultQualityFloor: 0.7,
      roleQualityFloors: {},
      roles: [],
    });
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.loadQualityControlsConfig).toHaveBeenCalledWith(mocks.sql, "hive-1");
  });
});
