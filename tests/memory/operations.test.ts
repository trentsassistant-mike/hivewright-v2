import { describe, it, expect, beforeEach } from "vitest";
import { applyMemoryOperations } from "@/memory/operations";
import type { MemoryOperation } from "@/memory/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('p4-ops-test', 'P4 Ops Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  // role_memory has a FK on role_slug → role_templates.slug.
  // Seed the role the tests use so direct role_memory inserts don't violate the constraint.
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("applyMemoryOperations", () => {
  it("ADD inserts new role_memory entry", async () => {
    const ops: MemoryOperation[] = [
      { operation: "ADD", store: "role_memory", content: "p4-ops-rate-limit is 60/min", confidence: 0.9 },
    ];
    const results = await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });
    expect(results).toHaveLength(1);
    expect(results[0].applied).toBe(true);
    const [row] = await sql`SELECT * FROM role_memory WHERE content = 'p4-ops-rate-limit is 60/min'`;
    expect(row).toBeDefined();
    expect(row.role_slug).toBe("dev-agent");
    expect(row.hive_id).toBe(bizId);
    expect(Number(row.confidence)).toBeCloseTo(0.9);
  });

  it("ADD inserts new hive_memory entry with category", async () => {
    const ops: MemoryOperation[] = [
      { operation: "ADD", store: "hive_memory", content: "p4-ops-Easter is peak season", confidence: 0.95, category: "seasonal" },
    ];
    const results = await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });
    expect(results[0].applied).toBe(true);
    const [row] = await sql`SELECT * FROM hive_memory WHERE content = 'p4-ops-Easter is peak season'`;
    expect(row.category).toBe("seasonal");
  });

  it("UPDATE modifies existing entry", async () => {
    const [existing] = await sql`
      INSERT INTO role_memory (hive_id, role_slug, content, confidence)
      VALUES (${bizId}, 'dev-agent', 'p4-ops-old rate limit is 30/min', 0.7)
      RETURNING *
    `;
    const ops: MemoryOperation[] = [
      { operation: "UPDATE", store: "role_memory", existingId: existing.id, content: "p4-ops-rate limit increased to 120/min", confidence: 0.95 },
    ];
    const results = await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });
    expect(results[0].applied).toBe(true);
    const [updated] = await sql`SELECT * FROM role_memory WHERE id = ${existing.id}`;
    expect(updated.content).toBe("p4-ops-rate limit increased to 120/min");
    expect(Number(updated.confidence)).toBeCloseTo(0.95);
  });

  it("DELETE soft-deletes by setting superseded_by", async () => {
    const [existing] = await sql`
      INSERT INTO hive_memory (hive_id, category, content, confidence)
      VALUES (${bizId}, 'competitor', 'p4-ops-Competitor X uses old pricing', 0.8)
      RETURNING *
    `;
    const ops: MemoryOperation[] = [
      { operation: "DELETE", store: "hive_memory", existingId: existing.id, reason: "Pricing updated" },
    ];
    const results = await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });
    expect(results[0].applied).toBe(true);
    const [deleted] = await sql`SELECT * FROM hive_memory WHERE id = ${existing.id}`;
    expect(deleted.superseded_by).not.toBeNull();
  });

  it("NOOP bumps last_accessed and access_count", async () => {
    const [existing] = await sql`
      INSERT INTO role_memory (hive_id, role_slug, content, confidence, access_count)
      VALUES (${bizId}, 'dev-agent', 'p4-ops-known fact', 0.9, 5)
      RETURNING *
    `;
    const ops: MemoryOperation[] = [
      { operation: "NOOP", store: "role_memory", existingId: existing.id, reason: "Already known" },
    ];
    const results = await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });
    expect(results[0].applied).toBe(true);
    const [row] = await sql`SELECT * FROM role_memory WHERE id = ${existing.id}`;
    expect(row.access_count).toBe(6);
    expect(row.last_accessed).not.toBeNull();
  });

  it("handles multiple operations in one batch", async () => {
    const ops: MemoryOperation[] = [
      { operation: "ADD", store: "role_memory", content: "p4-ops-batch-fact-1", confidence: 0.8 },
      { operation: "ADD", store: "hive_memory", content: "p4-ops-batch-fact-2", confidence: 0.7, category: "market" },
    ];
    const results = await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.applied)).toBe(true);
  });
});
