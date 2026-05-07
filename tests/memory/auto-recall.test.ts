import { describe, it, expect, beforeEach } from "vitest";
import { buildRecallInjection, getDefaultAutoRecallConfig } from "@/memory/auto-recall";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`INSERT INTO hives (slug, name, type) VALUES ('p6-recall-test', 'Recall Test', 'digital') RETURNING *`;
  bizId = biz.id;
  // role_memory has FK on role_templates.slug — seed the role first
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence) VALUES (${bizId}, 'dev-agent', 'p6-recall-API uses pagination with cursor', 0.9)`;
  await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence) VALUES (${bizId}, 'dev-agent', 'p6-recall-Rate limit is 100/min', 0.85)`;
});

describe("buildRecallInjection", () => {
  it("returns relevant memories based on recent activity", async () => {
    const result = await buildRecallInjection(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      recentActivity: "Working on API pagination implementation",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("p6-recall-");
  });

  it("returns null when no relevant memories exist", async () => {
    const result = await buildRecallInjection(sql, {
      roleSlug: "bookkeeper",
      hiveId: bizId,
      department: "finance",
      recentActivity: "Reconciling invoices",
    });
    // bookkeeper has no memories for this hive
    expect(result).toBeNull();
  });
});

describe("getDefaultAutoRecallConfig", () => {
  it("returns default config", () => {
    const config = getDefaultAutoRecallConfig();
    expect(config.enabled).toBe(true);
    expect(config.intervalCalls).toBe(10);
    expect(config.maxTokens).toBe(200);
  });
});
