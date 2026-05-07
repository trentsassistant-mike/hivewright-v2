import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    realpathSync: { native: vi.fn((p: string) => p) },
  },
}));

vi.mock("../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

vi.mock("../_lib/responses", () => ({
  jsonOk: (data: unknown, status?: number) =>
    new Response(JSON.stringify({ data }), { status: status ?? 200 }),
  jsonError: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), { status }),
  jsonPaginated: (data: unknown, total: number) =>
    new Response(JSON.stringify({ data, total }), { status: 200 }),
  parseSearchParams: (url: string) => {
    const u = new URL(url);
    return {
      get: (k: string) => u.searchParams.get(k),
      getInt: (k: string, def: number) => {
        const v = u.searchParams.get(k);
        return v ? parseInt(v, 10) : def;
      },
    };
  },
}));

import { POST } from "./route";
import { sql } from "../_lib/db";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";
import fs from "fs";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const mockMkdirSync = fs.mkdirSync as unknown as ReturnType<typeof vi.fn>;
const mockRealpathSync = fs.realpathSync.native as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const TEST_HIVES_ROOT = path.join(os.tmpdir(), "hw-project-route-hives");
const projectRoot = (bizSlug = "my-biz") => path.join(TEST_HIVES_ROOT, bizSlug, "projects");
const projectPath = (slug = "my-proj", bizSlug = "my-biz") => path.join(projectRoot(bizSlug), slug);

function mockHiveLookup(bizSlug = "my-biz") {
  mockSql.mockResolvedValueOnce([{ biz_slug: bizSlug, workspace_path: projectRoot(bizSlug) }]);
}

function mockInsert(workspacePath = projectPath()) {
  mockSql.mockResolvedValueOnce([{
    id: "proj-1",
    hive_id: "biz-1",
    slug: "my-proj",
    name: "My Project",
    workspace_path: workspacePath,
    git_repo: true,
    created_at: new Date(),
    updated_at: new Date(),
  }]);
}

function projectRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HIVES_WORKSPACE_ROOT = TEST_HIVES_ROOT;
    mockExistsSync.mockImplementation((p: string) => p === projectRoot());
    mockRealpathSync.mockImplementation((p: string) => p);
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@local", isSystemOwner: true },
    });
  });

  it("rejects non-members before hive lookup or filesystem writes", async () => {
    mockRequireApiUser.mockResolvedValue({
      user: { id: "member-1", email: "member@local", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(false);

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
    }));

    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects explicit workspacePath from non-owner hive members", async () => {
    mockRequireApiUser.mockResolvedValue({
      user: { id: "member-1", email: "member@local", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
      workspacePath: projectPath("custom"),
    }));

    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: explicit workspacePath requires system owner");
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("auto-derives workspacePath under the hive projects root", async () => {
    mockHiveLookup();
    mockInsert();

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.workspacePath).toBe(projectPath());

    expect(mockMkdirSync).toHaveBeenCalledWith(
      projectRoot(),
      { recursive: true }
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      projectPath(),
      { recursive: true }
    );
  });

  it("allows system-owner explicit workspacePath only inside the hive projects root", async () => {
    mockHiveLookup();
    mockInsert(projectPath("custom"));

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
      workspacePath: projectPath("custom"),
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.workspacePath).toBe(projectPath("custom"));
    expect(mockMkdirSync).toHaveBeenCalledWith(
      projectPath("custom"),
      { recursive: true }
    );
  });

  it("rejects system-owner explicit workspacePath outside the hive projects root", async () => {
    mockHiveLookup();

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
      workspacePath: "/tmp/arbitrary",
    }));

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("workspacePath must be inside the hive projects workspace root");
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("rejects invalid stored hive slugs before filesystem writes", async () => {
    mockHiveLookup("../escape");

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
    }));

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid hive slug for workspace root");
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("rejects traversal project slugs before filesystem writes", async () => {
    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "../escape",
      name: "My Project",
    }));

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid project slug");
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects symlink escapes after directory creation", async () => {
    mockHiveLookup();
    mockRealpathSync.mockImplementation((p: string) =>
      p === projectPath() ? "/tmp/escaped" : p
    );

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
    }));

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("workspacePath resolves outside the hive projects workspace root");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("rejects symlink parent escapes before project directory creation", async () => {
    mockHiveLookup();
    mockExistsSync.mockImplementation((p: string) =>
      p === projectRoot() ||
      p === projectPath("link")
    );
    mockRealpathSync.mockImplementation((p: string) =>
      p === projectPath("link") ? "/tmp/escaped-parent" : p
    );

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
      workspacePath: path.join(projectPath("link"), "my-proj"),
    }));

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("workspacePath parent resolves outside the hive projects workspace root");
    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
    expect(mockMkdirSync).toHaveBeenCalledWith(
      projectRoot(),
      { recursive: true }
    );
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("rejects hive projects root symlink escapes before creating the root", async () => {
    mockHiveLookup();
    mockExistsSync.mockImplementation((p: string) =>
      p === TEST_HIVES_ROOT ||
      p === path.join(TEST_HIVES_ROOT, "my-biz")
    );
    mockRealpathSync.mockImplementation((p: string) =>
      p === path.join(TEST_HIVES_ROOT, "my-biz") ? "/tmp/escaped-hive" : p
    );

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
    }));

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("workspacePath parent resolves outside the hive projects workspace root");
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("auto-derives workspacePath under configured HIVES_WORKSPACE_ROOT", async () => {
    process.env.HIVES_WORKSPACE_ROOT = "/tmp/hw-project-hives";
    mockExistsSync.mockImplementation((p: string) => p === "/tmp/hw-project-hives/my-biz/projects");
    mockHiveLookup();
    mockInsert("/tmp/hw-project-hives/my-biz/projects/my-proj");

    const res = await POST(projectRequest({
      hiveId: "biz-1",
      slug: "my-proj",
      name: "My Project",
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.workspacePath).toBe("/tmp/hw-project-hives/my-biz/projects/my-proj");
    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/tmp/hw-project-hives/my-biz/projects",
      { recursive: true },
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/tmp/hw-project-hives/my-biz/projects/my-proj",
      { recursive: true },
    );
  });
});
