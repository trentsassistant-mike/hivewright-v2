import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  sql: vi.fn(),
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

const { GET } = await import("@/app/api/work-products/[id]/download/route");

describe("GET /api/work-products/[id]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "owner@example.com", displayName: null, isSystemOwner: true },
    });
  });

  it("streams a generated image artifact from a hive-scoped path", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-wp-download-"));
    const filePath = path.join(workspace, "task-id", "images", "generated.png");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from("image-bytes"));
    mocks.sql.mockResolvedValueOnce([{
      file_path: filePath,
      mime_type: "image/png",
      artifact_kind: "image",
      hive_id: "hive-1",
      workspace_path: workspace,
    }]);

    try {
      const response = await GET(new Request("http://localhost/api/work-products/wp-1/download"), {
        params: Promise.resolve({ id: "wp-1" }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("image-bytes"));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects image artifact paths outside the owning hive workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-wp-download-"));
    const outside = path.join(os.tmpdir(), "outside-generated.png");
    fs.writeFileSync(outside, Buffer.from("nope"));
    mocks.sql.mockResolvedValueOnce([{
      file_path: outside,
      mime_type: "image/png",
      artifact_kind: "image",
      hive_id: "hive-1",
      workspace_path: workspace,
    }]);

    try {
      const response = await GET(new Request("http://localhost/api/work-products/wp-1/download"), {
        params: Promise.resolve({ id: "wp-1" }),
      });

      expect(response.status).toBe(404);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it("rejects image artifacts with unsupported mime types", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-wp-download-"));
    const filePath = path.join(workspace, "task-id", "images", "generated.svg");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from("<svg />"));
    mocks.sql.mockResolvedValueOnce([{
      file_path: filePath,
      mime_type: "image/svg+xml",
      artifact_kind: "image",
      hive_id: "hive-1",
      workspace_path: workspace,
    }]);

    try {
      const response = await GET(new Request("http://localhost/api/work-products/wp-1/download"), {
        params: Promise.resolve({ id: "wp-1" }),
      });

      expect(response.status).toBe(404);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requires hive access for non-owner sessions", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "member@example.com", displayName: null, isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);
    mocks.sql.mockResolvedValueOnce([{
      file_path: "/tmp/hive/task/images/generated.png",
      mime_type: "image/png",
      artifact_kind: "image",
      hive_id: "hive-1",
      workspace_path: "/tmp/hive",
    }]);

    const response = await GET(new Request("http://localhost/api/work-products/wp-1/download"), {
      params: Promise.resolve({ id: "wp-1" }),
    });

    expect(response.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
  });
});
