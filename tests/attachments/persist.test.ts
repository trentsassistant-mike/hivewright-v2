import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { persistAttachmentsForParent } from "@/attachments/persist";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const TEST_SLUG = "test-biz-attachment-persist";
const TEST_BASE = `/home/example/hives/${TEST_SLUG}`;
const MISSING_TASK_ID = "00000000-0000-0000-0000-000000000404";

let hiveId: string;

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    return [entryPath];
  });
}

beforeEach(async () => {
  await truncateAll(sql);
  if (fs.existsSync(TEST_BASE)) {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }

  const [hive] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES (${TEST_SLUG}, 'Attachment Persist Test Hive', 'digital', '/tmp')
    RETURNING id
  `;
  hiveId = hive.id as string;
});

afterEach(() => {
  if (fs.existsSync(TEST_BASE)) {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

describe("persistAttachmentsForParent", () => {
  it("persists attachment metadata and writes the file for a valid parent", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, qa_required)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'Attachment task', 'Attach the file', false)
      RETURNING id
    `;
    const taskId = task.id as string;
    const bytes = Buffer.from("successful-attachment");

    await persistAttachmentsForParent(
      sql,
      hiveId,
      taskId,
      [new File([bytes], "evidence.txt", { type: "text/plain" })],
      { taskId },
    );

    const rows = await sql`
      SELECT filename, storage_path, mime_type, size_bytes
      FROM task_attachments
      WHERE task_id = ${taskId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("evidence.txt");
    expect(rows[0].mime_type).toBe("text/plain");
    expect(Number(rows[0].size_bytes)).toBe(bytes.length);
    expect(fs.readFileSync(rows[0].storage_path as string)).toEqual(bytes);
  });

  it("does not leave an orphan file when attachment metadata insert fails", async () => {
    const unrelatedDir = path.join(TEST_BASE, "task-attachments", MISSING_TASK_ID);
    const unrelatedFile = path.join(unrelatedDir, "unrelated.txt");
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(unrelatedFile, "keep me");

    const filesBefore = listFiles(TEST_BASE);

    await expect(
      persistAttachmentsForParent(
        sql,
        hiveId,
        MISSING_TASK_ID,
        [new File(["orphan-risk"], "should-not-exist.txt", { type: "text/plain" })],
        { taskId: MISSING_TASK_ID },
      ),
    ).rejects.toThrow();

    const rows = await sql`
      SELECT id
      FROM task_attachments
      WHERE task_id = ${MISSING_TASK_ID}
    `;
    expect(rows).toHaveLength(0);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(listFiles(TEST_BASE).sort()).toEqual(filesBefore.sort());
  });
});
