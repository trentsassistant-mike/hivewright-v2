import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { writeAttachment } from "@/attachments/writer";

const TEST_BIZ_SLUG = "test-biz-writer-unit";
const TEST_PARENT_ID = "00000000-0000-0000-0000-000000000001";
const ORIGINAL_HIVES_WORKSPACE_ROOT = process.env.HIVES_WORKSPACE_ROOT;

let testRoot: string;
let testBase: string;

describe("writeAttachment", () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hw-attachment-writer-"));
    process.env.HIVES_WORKSPACE_ROOT = testRoot;
    testBase = path.join(testRoot, TEST_BIZ_SLUG);
  });

  afterEach(() => {
    if (ORIGINAL_HIVES_WORKSPACE_ROOT === undefined) {
      delete process.env.HIVES_WORKSPACE_ROOT;
    } else {
      process.env.HIVES_WORKSPACE_ROOT = ORIGINAL_HIVES_WORKSPACE_ROOT;
    }
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
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
      path.join(testBase, "task-attachments", TEST_PARENT_ID) + path.sep,
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
