import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

vi.mock("@/memory/embeddings", () => ({
  checkPgvectorAvailable: vi.fn(),
  storeEmbedding: vi.fn(),
}));

import { GET, POST } from "./route";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { checkPgvectorAvailable, storeEmbedding } from "@/memory/embeddings";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockCheckPgvectorAvailable = checkPgvectorAvailable as unknown as ReturnType<typeof vi.fn>;
const mockStoreEmbedding = storeEmbedding as unknown as ReturnType<typeof vi.fn>;
const params = { params: Promise.resolve({ id: "hive-1" }) };

let tempRoot = "";
const originalRoot = process.env.HIVES_WORKSPACE_ROOT;

function request(url: string) {
  return new Request(`http://localhost${url}`);
}

function mockHive() {
  mockSql.mockResolvedValueOnce([{
    id: "hive-1",
    slug: "test-hive",
    workspace_path: path.join(tempRoot, "test-hive", "projects"),
  }]);
}

describe("GET /api/hives/[id]/files", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "hw-files-"));
    process.env.HIVES_WORKSPACE_ROOT = tempRoot;
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mockCheckPgvectorAvailable.mockResolvedValue(false);
    mockStoreEmbedding.mockResolvedValue(["embedding-1"]);
  });

  afterEach(async () => {
    process.env.HIVES_WORKSPACE_ROOT = originalRoot;
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects unauthenticated callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request("/api/hives/hive-1/files?category=projects"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("rejects callers without hive access before listing files", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockHive();
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request("/api/hives/hive-1/files?category=projects"), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: hive access required");
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("lists filesystem-backed project files and DB-backed project metadata", async () => {
    await fsp.mkdir(path.join(tempRoot, "test-hive", "projects", "app"), { recursive: true });
    await fsp.writeFile(path.join(tempRoot, "test-hive", "projects", "app", "README.md"), "# App\n");
    mockHive();
    mockSql.mockResolvedValueOnce([{
      id: "project-1",
      slug: "app",
      name: "App",
      workspace_path: path.join(tempRoot, "test-hive", "projects", "app"),
      created_at: new Date("2026-05-01T00:00:00Z"),
      updated_at: new Date("2026-05-01T01:00:00Z"),
    }]);

    const res = await GET(request("/api/hives/hive-1/files?category=projects"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.responseShape).toBe("hive-file-browser-v1");
    expect(body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "App", source: "database", type: "Project workspace" }),
      expect.objectContaining({ name: "README.md", source: "filesystem", previewable: true }),
    ]));
  });

  it("omits symlink escapes from filesystem-backed listings", async () => {
    await fsp.mkdir(path.join(tempRoot, "test-hive", "projects"), { recursive: true });
    await fsp.mkdir(path.join(tempRoot, "outside"), { recursive: true });
    await fsp.writeFile(path.join(tempRoot, "outside", "secret.md"), "secret");
    fs.symlinkSync(path.join(tempRoot, "outside"), path.join(tempRoot, "test-hive", "projects", "outside-link"), "dir");
    mockHive();
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(request("/api/hives/hive-1/files?category=projects"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(JSON.stringify(body.data.items)).not.toContain("secret.md");
  });

  it("rejects path traversal preview attempts", async () => {
    await fsp.mkdir(path.join(tempRoot, "test-hive", "projects"), { recursive: true });
    await fsp.writeFile(path.join(tempRoot, "test-hive", "secret.md"), "secret");
    mockHive();

    const res = await GET(request("/api/hives/hive-1/files?category=projects&action=preview&path=../secret.md"), params);

    expect(res.status).toBe(404);
  });

  it("previews markdown and invalid JSON as raw text without failing", async () => {
    mockHive();
    mockSql.mockResolvedValueOnce([{
      id: "doc-1",
      title: "Bad data",
      format: "json",
      body: "{not valid json",
    }]);

    const res = await GET(request("/api/hives/hive-1/files?category=generated-docs&action=preview&id=doc-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      content: "{not valid json",
      contentType: "application/json",
      truncated: false,
    });
  });

  it("downloads binary filesystem files without corrupting bytes", async () => {
    await fsp.mkdir(path.join(tempRoot, "test-hive", "projects", "app"), { recursive: true });
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    await fsp.writeFile(path.join(tempRoot, "test-hive", "projects", "app", "bundle.zip"), bytes);
    mockHive();

    const res = await GET(request("/api/hives/hive-1/files?category=projects&action=download&path=app/bundle.zip"), params);
    const body = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("bundle.zip");
    expect(body).toEqual(bytes);
  });

  it("lists DB-backed attachments for the hive", async () => {
    mockHive();
    mockSql.mockResolvedValueOnce([{
      id: "attachment-1",
      filename: "notes.txt",
      storage_path: path.join(tempRoot, "test-hive", "ea", "notes.txt"),
      mime_type: "text/plain",
      size_bytes: 12,
      uploaded_at: new Date("2026-05-01T00:00:00Z"),
    }]);

    const res = await GET(request("/api/hives/hive-1/files?category=attachments"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.items).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        name: "notes.txt",
        source: "database",
        previewable: true,
        downloadable: true,
      }),
    ]);
  });
  it("uploads and indexes text reference documents into the hive reference folder", async () => {
    mockHive();
    mockSql.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]);
    const form = new FormData();
    form.append("title", "Cancellation policy");
    form.append("file", new File(["Refunds require 48 hours notice\napi_key=SECRET_VALUE"], "policy.md", { type: "text/markdown" }));

    const res = await POST(new Request("http://localhost/api/hives/hive-1/files?category=reference-documents", {
      method: "POST",
      body: form,
    }), params);
    if (!res) {
      throw new Error("Expected reference document upload response");
    }
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.responseShape).toBe("hive-reference-document-upload-v1");
    expect(body.data.item.name).toBe("Cancellation policy.md");
    expect(body.data.item.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.data.item.indexedChunks).toBe(1);
    await expect(fsp.readFile(path.join(tempRoot, "test-hive", "reference-documents", "Cancellation policy.md"), "utf8"))
      .resolves.toBe("Refunds require 48 hours notice\napi_key=SECRET_VALUE");
    expect(mockCheckPgvectorAvailable).toHaveBeenCalled();
    expect(mockStoreEmbedding).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      sourceType: "hive_reference_document",
      sourceId: "11111111-1111-4111-8111-111111111111",
      hiveId: "hive-1",
      pgvectorEnabled: false,
      text: expect.stringContaining("Refunds require 48 hours notice"),
    }));
    expect(mockStoreEmbedding.mock.calls[0][1].text).toContain("api_key=[REDACTED]");
  });

  it("rejects reference document uploads when the reference folder escapes the hive workspace", async () => {
    await fsp.mkdir(path.join(tempRoot, "test-hive"), { recursive: true });
    await fsp.mkdir(path.join(tempRoot, "outside-reference-documents"), { recursive: true });
    fs.symlinkSync(
      path.join(tempRoot, "outside-reference-documents"),
      path.join(tempRoot, "test-hive", "reference-documents"),
      "dir",
    );
    mockHive();
    const form = new FormData();
    form.append("file", new File(["Do not leak"], "policy.md", { type: "text/markdown" }));

    const res = await POST(new Request("http://localhost/api/hives/hive-1/files?category=reference-documents", {
      method: "POST",
      body: form,
    }), params);
    if (!res) {
      throw new Error("Expected reference document upload response");
    }
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("reference document directory escapes hive workspace");
    await expect(fsp.access(path.join(tempRoot, "outside-reference-documents", "policy.md"))).rejects.toThrow();
  });

  it("lists reference documents as filesystem-backed files", async () => {
    await fsp.mkdir(path.join(tempRoot, "test-hive", "reference-documents"), { recursive: true });
    await fsp.writeFile(path.join(tempRoot, "test-hive", "reference-documents", "faq.md"), "# FAQ");
    mockHive();

    const res = await GET(request("/api/hives/hive-1/files?category=reference-documents"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.items).toEqual([
      expect.objectContaining({
        name: "faq.md",
        category: "reference-documents",
        location: "reference-documents/faq.md",
        previewable: true,
      }),
    ]);
  });

});
