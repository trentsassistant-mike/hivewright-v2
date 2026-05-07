import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  default: { mkdirSync: vi.fn() },
}));

vi.mock("../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("@/hives/seed-schedules", () => ({
  seedDefaultSchedules: vi.fn(),
}));

import fs from "fs";
import { GET, POST } from "./route";
import { sql } from "../_lib/db";
import { requireApiUser } from "../_lib/auth";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockMkdirSync = fs.mkdirSync as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;

function hiveCreateRequest(slug: string) {
  return new Request("http://localhost/api/hives", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Hive",
      slug,
      type: "business",
    }),
  });
}

describe("POST /api/hives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HIVES_WORKSPACE_ROOT;
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it.each([
    "../escape",
    "bad/slug",
    "Uppercase",
    "bad_slug",
    "bad.slug",
    "-leading",
    "a",
    "a".repeat(65),
  ])("rejects invalid slug %s before DB or filesystem use", async (slug) => {
    const res = await POST(hiveCreateRequest(slug));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("slug must match ^[a-z0-9][a-z0-9-]{1,63}$");
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("rejects non-owner authenticated users before DB or filesystem use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });

    const res = await POST(hiveCreateRequest("valid-hive"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: system owner role required" });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("accepts a valid slug for a system owner and creates hive directories", async () => {
    mockSql.mockResolvedValueOnce([{
      id: "hive-1",
      name: "Test Hive",
      slug: "valid-hive",
      type: "business",
      description: null,
    }]);

    const res = await POST(hiveCreateRequest("valid-hive"));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      id: "hive-1",
      name: "Test Hive",
      slug: "valid-hive",
      type: "business",
    });
    expect(mockMkdirSync).toHaveBeenCalledWith("/home/example/hives/valid-hive/projects", { recursive: true });
    expect(mockMkdirSync).toHaveBeenCalledWith("/home/example/hives/valid-hive/skills", { recursive: true });
    expect(mockMkdirSync).toHaveBeenCalledWith("/home/example/hives/valid-hive/ea", { recursive: true });
  });

  it("uses HIVES_WORKSPACE_ROOT for new hive project paths when configured", async () => {
    process.env.HIVES_WORKSPACE_ROOT = "/tmp/hw-test-hives";
    mockSql.mockResolvedValueOnce([{
      id: "hive-1",
      name: "Test Hive",
      slug: "valid-hive",
      type: "business",
      description: null,
    }]);

    const res = await POST(hiveCreateRequest("valid-hive"));

    expect(res.status).toBe(201);
    expect(mockSql.mock.calls[0]).toContain("/tmp/hw-test-hives/valid-hive/projects");
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/hw-test-hives/valid-hive/projects", { recursive: true });
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/hw-test-hives/valid-hive/skills", { recursive: true });
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/hw-test-hives/valid-hive/ea", { recursive: true });
  });
});

describe("GET /api/hives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HIVES_WORKSPACE_ROOT;
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("rejects unauthenticated callers before listing hives", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/hives"));

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("filters non-owner hive lists through hive memberships", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([{
      id: "hive-1",
      slug: "member-hive",
      name: "Member Hive",
      type: "business",
      description: null,
      workspace_path: "/home/example/hives/member-hive/projects",
      is_system_fixture: false,
      created_at: "2026-04-27T00:00:00.000Z",
    }]);

    const res = await GET(new Request("http://localhost/api/hives"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{
      id: "hive-1",
      slug: "member-hive",
      name: "Member Hive",
      type: "business",
      description: null,
      workspacePath: "/home/example/hives/member-hive/projects",
      isSystemFixture: false,
      createdAt: "2026-04-27T00:00:00.000Z",
    }]);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(String(mockSql.mock.calls[0][0])).toContain("INNER JOIN hive_memberships");
    expect(mockSql.mock.calls[0]).toContain("member-1");
  });
});
