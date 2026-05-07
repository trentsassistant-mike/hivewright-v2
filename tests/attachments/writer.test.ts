import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { writeAttachment } from "@/attachments/writer";

const TEST_BIZ_SLUG = "test-biz-writer-unit";
const TEST_PARENT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_BASE = `/home/example/hives/${TEST_BIZ_SLUG}`;

describe("writeAttachment", () => {
  afterEach(() => {
    if (fs.existsSync(TEST_BASE)) {
      fs.rmSync(TEST_BASE, { recursive: true, force: true });
    }
  });

  it("writes file bytes to disk and returns correct row", async () => {
    const content = Buffer.from("PNG-fake-bytes");
    const file = new File([content], "screenshot.png", { type: "image/png" });

    const row = await writeAttachment(TEST_BIZ_SLUG, TEST_PARENT_ID, file);

    expect(row.filename).toBe("screenshot.png");
    expect(row.mimeType).toBe("image/png");
    expect(row.sizeBytes).toBe(content.length);
    expect(fs.existsSync(row.storagePath)).toBe(true);
    expect(fs.readFileSync(row.storagePath)).toEqual(content);

    // Path contains hive slug and task ID
    expect(row.storagePath).toContain(
      `/home/example/hives/${TEST_BIZ_SLUG}/task-attachments/${TEST_PARENT_ID}/`
    );
    // Filename is uuid-prefixed original name
    expect(path.basename(row.storagePath)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-screenshot\.png$/
    );
  });

  it("creates intermediate directories that do not exist", async () => {
    const file = new File(["doc"], "notes.txt", { type: "text/plain" });
    const row = await writeAttachment(TEST_BIZ_SLUG, TEST_PARENT_ID, file);

    expect(fs.existsSync(row.storagePath)).toBe(true);
  });

  it("returns null mimeType when file has no type", async () => {
    const file = new File(["data"], "data.bin");
    const row = await writeAttachment(TEST_BIZ_SLUG, TEST_PARENT_ID, file);

    expect(row.mimeType).toBeNull();
  });
});
