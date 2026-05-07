import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { GET } from "@/app/api/attachments/[id]/download/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const TEST_SLUG = "test-biz-att-dl";
let bizId: string;
let taskId: string;

const TEST_DIR = path.join(
  "/home/example/hives",
  TEST_SLUG,
  "task-attachments",
  "task-uuid",
);

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES (${TEST_SLUG}, 'Att DL Biz', 'digital', '/tmp')
    RETURNING *
  `;
  bizId = biz.id;
  const [task] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, qa_required)
    VALUES (${bizId}, 'dev-agent', 'owner', 't', 'b', false)
    RETURNING id
  `;
  taskId = task.id as string;

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  const hiveRoot = `/home/example/hives/${TEST_SLUG}`;
  if (fs.existsSync(hiveRoot)) fs.rmSync(hiveRoot, { recursive: true, force: true });
});

describe("GET /api/attachments/[id]/download", () => {
  it("streams the file bytes back with correct headers", async () => {
    const filePath = path.join(TEST_DIR, "fixture.png");
    const fileBytes = Buffer.from("fake-png-bytes");
    fs.writeFileSync(filePath, fileBytes);

    const [att] = await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${taskId}, 'screenshot.png', ${filePath}, 'image/png', ${fileBytes.length})
      RETURNING id
    `;
    const attachmentId = att.id as string;

    const request = new Request(`http://localhost/api/attachments/${attachmentId}/download`);
    const response = await GET(request, {
      params: Promise.resolve({ id: attachmentId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="screenshot.png"');

    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    expect(bodyBuffer).toEqual(fileBytes);
  });

  it("falls back to application/octet-stream when mime_type is null", async () => {
    const filePath = path.join(TEST_DIR, "raw.bin");
    fs.writeFileSync(filePath, Buffer.from("xyz"));

    const [att] = await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${taskId}, 'raw.bin', ${filePath}, NULL, 3)
      RETURNING id
    `;
    const request = new Request(`http://localhost/api/attachments/${att.id}/download`);
    const response = await GET(request, {
      params: Promise.resolve({ id: att.id as string }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("returns 404 when attachment id is unknown", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000999";
    const request = new Request(`http://localhost/api/attachments/${fakeId}/download`);
    const response = await GET(request, {
      params: Promise.resolve({ id: fakeId }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 when storage_path resolves outside /home/example/hives", async () => {
    // Write a fixture in a tmp dir then point the row at it — must be rejected.
    const tmpFile = path.join(os.tmpdir(), "outside-hives.bin");
    fs.writeFileSync(tmpFile, Buffer.from("nope"));

    const [att] = await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${taskId}, 'outside.bin', ${tmpFile}, 'application/octet-stream', 4)
      RETURNING id
    `;
    const request = new Request(`http://localhost/api/attachments/${att.id}/download`);
    const response = await GET(request, {
      params: Promise.resolve({ id: att.id as string }),
    });
    expect(response.status).toBe(404);
    fs.rmSync(tmpFile, { force: true });
  });

  it("returns 404 when file is missing on disk", async () => {
    const phantomPath = path.join(TEST_DIR, "phantom.txt");
    // Note: do NOT create the file.
    const [att] = await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${taskId}, 'phantom.txt', ${phantomPath}, 'text/plain', 0)
      RETURNING id
    `;
    const request = new Request(`http://localhost/api/attachments/${att.id}/download`);
    const response = await GET(request, {
      params: Promise.resolve({ id: att.id as string }),
    });
    expect(response.status).toBe(404);
  });
});
