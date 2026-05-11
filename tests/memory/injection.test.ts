import { describe, it, expect, beforeEach } from "vitest";
import { queryRelevantMemory } from "@/memory/injection";
import type { MemoryContext } from "@/adapters/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('p4-inj-test', 'P4 Injection Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;
  // role_memory has FK on role_templates.slug — seed the role first
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("queryRelevantMemory", () => {
  it("returns role memory, hive memory, and insights for a task", async () => {
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence) VALUES (${bizId}, 'dev-agent', 'p4-inj-API rate limit is 100/min', 0.9)`;
    await sql`INSERT INTO hive_memory (hive_id, category, content, confidence) VALUES (${bizId}, 'operations', 'p4-inj-NewBook API is primary integration', 0.85)`;
    await sql`INSERT INTO insights (hive_id, content, connection_type, confidence, status, priority, affected_departments) VALUES (${bizId}, 'p4-inj-SEO traffic gap exists', 'opportunity', 0.7, 'new', 'medium', '["engineering"]')`;

    const result: MemoryContext = await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      taskBrief: "Fix the API integration with NewBook",
      pgvectorEnabled: false,
    });

    expect(result.roleMemory.length).toBeGreaterThanOrEqual(1);
    expect(result.roleMemory[0].content).toContain("p4-inj-API rate limit");
    expect(result.hiveMemory.length).toBeGreaterThanOrEqual(1);
    expect(result.hiveMemory[0].content).toContain("p4-inj-NewBook API");
    expect(result.insights.length).toBeGreaterThanOrEqual(1);
    expect(result.capacity).toMatch(/\d+\/200/);
    expect(result.provenance?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceClass: "role_memory",
          reference: expect.stringMatching(/^role_memory:/),
        }),
        expect.objectContaining({
          sourceClass: "hive_memory",
          reference: expect.stringMatching(/^hive_memory:/),
          category: "operations",
        }),
        expect.objectContaining({
          sourceClass: "insight",
          reference: expect.stringMatching(/^insights:/),
        }),
      ]),
    );
    expect(JSON.stringify(result.provenance)).not.toContain("p4-inj-API rate limit");
    expect(JSON.stringify(result.provenance)).not.toContain("p4-inj-NewBook API");
    expect(result.provenance?.disclaimer).toContain("not model-internal reasoning");
  });

  it("returns an explicit empty provenance state when no memory or context is retrieved", async () => {
    const result = await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: null,
      taskBrief: "No related memory",
      pgvectorEnabled: false,
    });

    expect(result.roleMemory).toEqual([]);
    expect(result.hiveMemory).toEqual([]);
    expect(result.insights).toEqual([]);
    expect(result.provenance).toEqual({
      status: "none",
      entries: [],
      disclaimer: expect.stringContaining("not model-internal reasoning"),
    });
  });

  it("excludes superseded memories", async () => {
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence, superseded_by) VALUES (${bizId}, 'dev-agent', 'p4-inj-old fact', 0.5, '00000000-0000-0000-0000-000000000000')`;
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence) VALUES (${bizId}, 'dev-agent', 'p4-inj-current fact', 0.9)`;

    const result = await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      taskBrief: "Test task",
      pgvectorEnabled: false,
    });

    const contents = result.roleMemory.map((m) => m.content);
    expect(contents).not.toContain("p4-inj-old fact");
    expect(contents).toContain("p4-inj-current fact");
  });

  it("annotates aging memories with freshness note", async () => {
    const agingDate = new Date();
    agingDate.setDate(agingDate.getDate() - 60);
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence, updated_at) VALUES (${bizId}, 'dev-agent', 'p4-inj-aging fact', 0.7, ${agingDate})`;

    const result = await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: null,
      taskBrief: "Test task",
      pgvectorEnabled: false,
    });

    const agingEntry = result.roleMemory.find((m) => m.content.includes("p4-inj-aging fact"));
    expect(agingEntry).toBeDefined();
    expect(agingEntry!.content).toMatch(/last updated \d+ days ago/);
  });

  it("bumps access_count on injected memories", async () => {
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence, access_count) VALUES (${bizId}, 'dev-agent', 'p4-inj-tracked fact', 0.9, 3)`;

    await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: null,
      taskBrief: "Test",
      pgvectorEnabled: false,
    });

    const [row] = await sql`SELECT access_count FROM role_memory WHERE content LIKE 'p4-inj-tracked fact'`;
    expect(row.access_count).toBe(4);
  });

  it("excludes restricted-sensitivity memories from injection", async () => {
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence, sensitivity) VALUES (${bizId}, 'dev-agent', 'p4-inj-secret API key data', 0.9, 'restricted')`;
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence, sensitivity) VALUES (${bizId}, 'dev-agent', 'p4-inj-normal fact', 0.9, 'internal')`;

    const result = await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: null,
      taskBrief: "Test",
      pgvectorEnabled: false,
    });

    const contents = result.roleMemory.map((m) => m.content);
    expect(contents.some((c) => c.includes("p4-inj-secret API key"))).toBe(false);
    expect(contents.some((c) => c.includes("p4-inj-normal fact"))).toBe(true);
  });
});
