import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  loadApprovedSkillCandidates: vi.fn(),
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

vi.mock("@/skills/self-creation", () => ({
  loadApprovedSkillCandidates: mocks.loadApprovedSkillCandidates,
}));

import { GET } from "./route";

function request() {
  return new Request("http://localhost/api/skills/approved?hiveId=hive-1&roleSlug=dev-agent");
}

describe("GET /api/skills/approved access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.loadApprovedSkillCandidates.mockResolvedValue([]);
  });

  it("returns 401 for signed-out callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.loadApprovedSkillCandidates).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.loadApprovedSkillCandidates).not.toHaveBeenCalled();
  });

  it("returns 200 when the signed-in caller can access the hive", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.loadApprovedSkillCandidates).toHaveBeenCalledWith(
      mocks.sql,
      "hive-1",
      "dev-agent",
    );
  });
});
