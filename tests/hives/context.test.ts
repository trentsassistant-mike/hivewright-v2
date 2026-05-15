import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { buildHiveContextBlock } from "../../src/hives/context";

async function insertHive(overrides: Partial<{
  name: string; slug: string; type: string;
  description: string | null; mission: string | null; softwareStack: string | null;
}> = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, description, mission, software_stack)
    VALUES (
      ${overrides.name ?? "Test Hive"},
      ${overrides.slug ?? `test-hive-${Math.random().toString(36).slice(2, 8)}`},
      ${overrides.type ?? "digital"},
      ${overrides.description ?? null},
      ${overrides.mission ?? null},
      ${overrides.softwareStack ?? null}
    )
    RETURNING id
  `;
  return row.id;
}

async function insertTarget(
  hiveId: string,
  t: { title: string; targetValue?: string; deadline?: string; sortOrder?: number },
): Promise<void> {
  await sql`
    INSERT INTO hive_targets (hive_id, title, target_value, deadline, sort_order)
    VALUES (${hiveId}, ${t.title}, ${t.targetValue ?? null},
            ${t.deadline ?? null}, ${t.sortOrder ?? 0})
  `;
}

describe("buildHiveContextBlock", () => {
  let tempRoot = "";
  const originalRoot = process.env.HIVES_WORKSPACE_ROOT;

  beforeEach(async () => {
    await truncateAll(sql);
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "hw-context-"));
    process.env.HIVES_WORKSPACE_ROOT = tempRoot;
  });

  afterEach(async () => {
    process.env.HIVES_WORKSPACE_ROOT = originalRoot;
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it("emits full block with mission + targets", async () => {
    const id = await insertHive({
      name: "Lakes Bushland", type: "physical",
      description: "111-site park", mission: "Passive income, 85% occupancy.",
    });
    await insertTarget(id, { title: "MRR", targetValue: "$50k/mo", deadline: "2026-12-31", sortOrder: 0 });
    await insertTarget(id, { title: "Reviews", targetValue: "≥ 4.7", sortOrder: 1 });

    const block = await buildHiveContextBlock(sql, id);

    expect(block).toContain("## Hive Context");
    expect(block).toContain("**Hive:** Lakes Bushland");
    expect(block).toContain("**Type:** physical");
    expect(block).toContain("**About:** 111-site park");
    expect(block).toContain("**Mission:**");
    expect(block).toContain("Passive income, 85% occupancy.");
    expect(block).toContain("**Targets:**");
    expect(block).toContain("- MRR: $50k/mo (by 2026-12-31)");
    expect(block).toContain("- Reviews: ≥ 4.7");
  });

  it("inserts Working in immediately after About when workspace is resolved", async () => {
    const id = await insertHive({
      name: "HiveWright",
      type: "digital",
      description: "Autonomous hive operating system.",
      mission: "Run the hive.",
    });

    const block = await buildHiveContextBlock(sql, id, "/tmp/hivewrightv2");

    expect(block).toContain("**Working in:** /tmp/hivewrightv2");
    expect(block.split("\n").slice(0, 5)).toEqual([
      "## Hive Context",
      "**Hive:** HiveWright",
      "**Type:** digital",
      "**About:** Autonomous hive operating system.",
      "**Working in:** /tmp/hivewrightv2",
    ]);
  });

  it("omits Working in when no workspace is resolved", async () => {
    const id = await insertHive({ description: "Operations hive" });
    const block = await buildHiveContextBlock(sql, id, null);
    expect(block).not.toContain("**Working in:**");
  });

  it("omits Mission subsection when mission is null/empty", async () => {
    const id = await insertHive({ mission: null, description: "A hive" });
    const block = await buildHiveContextBlock(sql, id);
    expect(block).not.toContain("**Mission:**");
    expect(block).toContain("**About:** A hive");
  });

  it("omits Targets subsection when no targets exist", async () => {
    const id = await insertHive({ mission: "Do the thing." });
    const block = await buildHiveContextBlock(sql, id);
    expect(block).toContain("**Mission:**");
    expect(block).not.toContain("**Targets:**");
  });

  it("omits About when description is null", async () => {
    const id = await insertHive({ description: null });
    const block = await buildHiveContextBlock(sql, id);
    expect(block).not.toContain("**About:**");
    expect(block).toContain("**Hive:**");
    expect(block).toContain("**Type:**");
  });

  it("renders name/type only when both mission and description missing", async () => {
    const id = await insertHive({ description: null, mission: null });
    const block = await buildHiveContextBlock(sql, id);
    expect(block).toContain("**Hive:**");
    expect(block).toContain("**Type:**");
    expect(block).not.toContain("**About:**");
    expect(block).not.toContain("**Mission:**");
    expect(block).not.toContain("**Targets:**");
  });

  it("orders targets by sort_order ascending", async () => {
    const id = await insertHive();
    await insertTarget(id, { title: "Third", sortOrder: 2 });
    await insertTarget(id, { title: "First", sortOrder: 0 });
    await insertTarget(id, { title: "Second", sortOrder: 1 });

    const block = await buildHiveContextBlock(sql, id);
    const firstIdx = block.indexOf("- First");
    const secondIdx = block.indexOf("- Second");
    const thirdIdx = block.indexOf("- Third");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("renders target with only title (no value, no deadline)", async () => {
    const id = await insertHive();
    await insertTarget(id, { title: "Unquantified aspiration" });
    const block = await buildHiveContextBlock(sql, id);
    expect(block).toContain("- Unquantified aspiration");
    expect(block).not.toContain("- Unquantified aspiration:");
    expect(block).not.toContain("(by ");
  });

  it("includes software stack and a lightweight reference document manifest without document contents", async () => {
    const slug = "lakes-bushland";
    const id = await insertHive({
      name: "Lakes Bushland",
      slug,
      softwareStack: "- Gmail: customer email\n- NewBook: bookings and guest records",
    });
    const referenceRoot = path.join(tempRoot, slug, "reference-documents");
    await fsp.mkdir(referenceRoot, { recursive: true });
    await fsp.writeFile(path.join(referenceRoot, "cancellation-policy.md"), "Guests need 48 hours notice for cancellation credit.");

    const block = await buildHiveContextBlock(sql, id);

    expect(block).toContain("**Software / Systems Used:**");
    expect(block).toContain("- Gmail: customer email");
    expect(block).toContain("- NewBook: bookings and guest records");
    expect(block).toContain("**Owner Reference Documents Available:**");
    expect(block).toContain("- cancellation-policy.md (`reference-documents/cancellation-policy.md`)");
    expect(block).toContain("Open/read these files only when the current task is relevant");
    expect(block).not.toContain("Guests need 48 hours notice for cancellation credit.");
  });

  it("includes task-relevant capped reference snippets without dumping unrelated document chunks", async () => {
    const slug = "lakes-reference-search";
    const id = await insertHive({ name: "Lakes Bushland", slug });
    const referenceRoot = path.join(tempRoot, slug, "reference-documents");
    await fsp.mkdir(referenceRoot, { recursive: true });
    await fsp.writeFile(path.join(referenceRoot, "cancellation-policy.md"), "Cancellation policy source file");

    const [doc] = await sql<{ id: string }[]>`
      INSERT INTO hive_reference_documents (hive_id, filename, relative_path, mime_type, size_bytes)
      VALUES (${id}, 'cancellation-policy.md', 'cancellation-policy.md', 'text/markdown', 128)
      RETURNING id
    `;
    await sql`
      INSERT INTO memory_embeddings (source_type, source_id, hive_id, chunk_text)
      VALUES
        ('hive_reference_document', ${doc.id}, ${id}, 'Cancellation refunds require 48 hours notice before arrival and must be handled in NewBook.'),
        ('hive_reference_document', ${doc.id}, ${id}, 'Pet rules: dogs must be on leash near the bushland trail.')
    `;

    const block = await buildHiveContextBlock(sql, id, null, "Guest asks for a cancellation refund after booking in NewBook");

    expect(block).toContain("**Owner Reference Documents Available:**");
    expect(block).toContain("**Relevant Owner Reference Snippets:**");
    expect(block).toContain("[cancellation-policy.md · reference-documents/cancellation-policy.md]");
    expect(block).toContain("Cancellation refunds require 48 hours notice");
    expect(block).not.toContain("dogs must be on leash");
  });

  it("returns empty string when hive id is unknown", async () => {
    const block = await buildHiveContextBlock(sql, "00000000-0000-0000-0000-000000000000");
    expect(block).toBe("");
  });

  it("filters out achieved and abandoned targets", async () => {
    const id = await insertHive();
    await sql`
      INSERT INTO hive_targets (hive_id, title, status, sort_order)
      VALUES
        (${id}, 'Open target', 'open', 0),
        (${id}, 'Achieved target', 'achieved', 1),
        (${id}, 'Abandoned target', 'abandoned', 2)
    `;
    const block = await buildHiveContextBlock(sql, id);
    expect(block).toContain("- Open target");
    expect(block).not.toContain("Achieved target");
    expect(block).not.toContain("Abandoned target");
  });

  it("truncates mission above 500 words with exact suffix + warns once", async () => {
    const longMission = Array.from({ length: 650 }, (_, i) => `word${i}`).join(" ");
    const id = await insertHive({ mission: longMission });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const block = await buildHiveContextBlock(sql, id);

    expect(block).toContain("word499"); // the 500th word (0-indexed)
    expect(block).not.toContain("word500");
    expect(block).toContain("… [mission truncated to 500 words]");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("passes missions at or below 500 words through unchanged with no warning", async () => {
    const mission = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
    const id = await insertHive({ mission });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const block = await buildHiveContextBlock(sql, id);

    expect(block).toContain("w499");
    expect(block).not.toContain("[mission truncated");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("includes standing instructions as owner-defined policies and procedures", async () => {
    const id = await insertHive();
    await sql`
      INSERT INTO standing_instructions (hive_id, content, affected_departments, confidence, created_at)
      VALUES
        (${id}, 'Never publish public marketing copy without owner approval.', '[]'::jsonb, 0.97, '2026-01-02T00:00:00Z'),
        (${id}, 'For bookkeeping close, reconcile bank feeds before drafting reports.', '["finance"]'::jsonb, 0.93, '2026-01-01T00:00:00Z')
    `;

    const block = await buildHiveContextBlock(sql, id);

    expect(block).toContain("**Policies / Rules / Owner Procedures:**");
    expect(block).toContain("Standing instructions are owner-defined guidance/procedures and are mandatory when applicable.");
    expect(block).toContain("- [standing instruction] Never publish public marketing copy without owner approval.");
    expect(block).toContain("- [standing instruction] For bookkeeping close, reconcile bank feeds before drafting reports.");
  });

  it("includes bounded policy-like hive memory without dumping all memory", async () => {
    const id = await insertHive();
    await sql`
      INSERT INTO hive_memory (hive_id, category, content, confidence, sensitivity, created_at, updated_at)
      VALUES
        (${id}, 'operations', 'Rule: never create new bookkeeping account codes without owner approval.', 0.96, 'internal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        (${id}, 'general', 'Policy: customer exports must stay inside the private workspace.', 0.91, 'internal', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        (${id}, 'market', 'HiveWright buyers prefer concise demos.', 0.99, 'internal', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
        (${id}, 'operations', 'Procedure: archive receipts after monthly reconciliation.', 0.4, 'internal', '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z'),
        (${id}, 'operations', 'Rule: restricted memory must not appear in supervisor context.', 0.99, 'restricted', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z')
    `;

    const block = await buildHiveContextBlock(sql, id);

    expect(block).toContain("**Policies / Rules / Owner Procedures:**");
    expect(block).toContain("- [hive memory: operations] Rule: never create new bookkeeping account codes without owner approval.");
    expect(block).toContain("- [hive memory: general] Policy: customer exports must stay inside the private workspace.");
    expect(block).not.toContain("HiveWright buyers prefer concise demos.");
    expect(block).not.toContain("archive receipts");
    expect(block).not.toContain("restricted memory");
  });
});
