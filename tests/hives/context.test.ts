import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { buildHiveContextBlock } from "../../src/hives/context";

async function insertHive(overrides: Partial<{
  name: string; slug: string; type: string;
  description: string | null; mission: string | null;
}> = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, description, mission)
    VALUES (
      ${overrides.name ?? "Test Hive"},
      ${overrides.slug ?? `test-hive-${Math.random().toString(36).slice(2, 8)}`},
      ${overrides.type ?? "digital"},
      ${overrides.description ?? null},
      ${overrides.mission ?? null}
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
  beforeEach(async () => {
    await truncateAll(sql);
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
});
