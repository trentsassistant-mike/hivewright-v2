import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { syncRoleLibrary } from "@/roles/sync";
import { extractAndStore } from "@/memory/extractor";
import { applyMemoryOperations } from "@/memory/operations";
import { queryRelevantMemory } from "@/memory/injection";
import { computeFreshness, formatWithFreshness } from "@/memory/freshness";
import { shouldRunSynthesis, runSynthesis } from "@/memory/synthesis";
import { chunkText } from "@/memory/embeddings";
import type { MemoryOperation } from "@/memory/types";
import type { ModelCallerConfig } from "@/memory/model-caller";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
const TEST_TASK_ID = "00000000-0000-0000-0000-000000000001";

const mockModelConfig = (response: unknown): ModelCallerConfig => ({
  ollamaUrl: "http://localhost:11434",
  generationModel: "mistral",
  embeddingModel: "all-minilm",
  fetchFn: vi.fn(async () =>
    new Response(JSON.stringify({ response: JSON.stringify(response) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch,
});

beforeEach(async () => {
  await truncateAll(sql);
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('p4-integ', 'P4 Integration', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  // Insert placeholder task for FK constraint in extractAndStore
  await sql`
    INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, priority, title, brief, qa_required)
    VALUES (${TEST_TASK_ID}, ${bizId}, 'dev-agent', 'system', 'completed', 5, 'p4-int-placeholder-task', 'test brief', false)
  `;
});

describe("Phase 4 Integration: Memory System", () => {
  it("fact extraction writes to role_memory and hive_memory", async () => {
    const config = mockModelConfig({
      facts: [
        { operation: "ADD", store: "role_memory", content: "p4-int-API uses OAuth2", confidence: 0.9 },
        { operation: "ADD", store: "hive_memory", content: "p4-int-Peak season is December", confidence: 0.85, category: "seasonal" },
      ],
    });

    const result = await extractAndStore(sql, {
      workProductContent: "Set up API integration. Uses OAuth2. Peak season is December.",
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      taskId: TEST_TASK_ID,
      existingRoleMemories: [],
      existingHiveMemories: [],
    }, config);

    expect(result.operationResults).toHaveLength(2);
    expect(result.operationResults.every((r) => r.applied)).toBe(true);

    const roleMem = await sql`SELECT * FROM role_memory WHERE content = 'p4-int-API uses OAuth2'`;
    expect(roleMem).toHaveLength(1);

    const bizMem = await sql`SELECT * FROM hive_memory WHERE content = 'p4-int-Peak season is December'`;
    expect(bizMem).toHaveLength(1);
    expect(bizMem[0].category).toBe("seasonal");
  });

  it("injection returns extracted memories for next task", async () => {
    // Seed memories directly so this test is self-contained
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence) VALUES (${bizId}, 'dev-agent', 'p4-int-API uses OAuth2', 0.9)`;
    await sql`INSERT INTO hive_memory (hive_id, category, content, confidence) VALUES (${bizId}, 'seasonal', 'p4-int-Peak season is December', 0.85)`;

    const result = await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      taskBrief: "Continue API integration work",
      pgvectorEnabled: false,
    });

    expect(result.roleMemory.some((m) => m.content.includes("p4-int-API uses OAuth2"))).toBe(true);
    expect(result.hiveMemory.some((m) => m.content.includes("p4-int-Peak season is December"))).toBe(true);
  });

  it("UPDATE operation modifies existing memory", async () => {
    // Seed the memory this test will update
    const [existing] = await sql`
      INSERT INTO role_memory (hive_id, role_slug, content, confidence)
      VALUES (${bizId}, 'dev-agent', 'p4-int-API uses OAuth2', 0.9)
      RETURNING *
    `;

    const ops: MemoryOperation[] = [
      { operation: "UPDATE", store: "role_memory", existingId: existing.id, content: "p4-int-API migrated to OAuth2 with PKCE", confidence: 0.95 },
    ];

    const results = await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });
    expect(results[0].applied).toBe(true);

    const [updated] = await sql`SELECT * FROM role_memory WHERE id = ${existing.id}`;
    expect(updated.content).toBe("p4-int-API migrated to OAuth2 with PKCE");
  });

  it("DELETE soft-deletes memory and injection excludes it", async () => {
    // Seed the memory this test will delete
    const [existing] = await sql`
      INSERT INTO role_memory (hive_id, role_slug, content, confidence)
      VALUES (${bizId}, 'dev-agent', 'p4-int-API migrated to OAuth2 with PKCE', 0.95)
      RETURNING *
    `;

    const ops: MemoryOperation[] = [
      { operation: "DELETE", store: "role_memory", existingId: existing.id, reason: "API changed again" },
    ];
    await applyMemoryOperations(sql, ops, {
      hiveId: bizId, roleSlug: "dev-agent", sourceTaskId: null,
    });

    const result = await queryRelevantMemory(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      taskBrief: "API work",
      pgvectorEnabled: false,
    });

    const deleted = result.roleMemory.find((m) => m.content.includes("p4-int-API migrated"));
    expect(deleted).toBeUndefined();
  });

  it("freshness annotations applied to aging memories", () => {
    const agingDate = new Date();
    agingDate.setDate(agingDate.getDate() - 60);
    expect(computeFreshness(agingDate)).toBe("aging");

    const formatted = formatWithFreshness("Old fact", agingDate);
    expect(formatted).toContain("last updated");
    expect(formatted).toContain("days ago");
  });

  it("text chunking works for long work products", () => {
    const longText = "This is a paragraph about hive operations. ".repeat(50);
    const chunks = chunkText(longText, 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(550);
    }
  });

  it("synthesis discovers insights from cross-department work products", async () => {
    for (let i = 0; i < 3; i++) {
      const [task] = await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
        VALUES (${bizId}, 'dev-agent', 'owner', ${'p4-int-eng-' + i}, 'Brief', 'completed')
        RETURNING *
      `;
      await sql`
        INSERT INTO work_products (task_id, hive_id, role_slug, department, content, summary, synthesized)
        VALUES (${task.id}, ${bizId}, 'dev-agent', 'engineering', ${'p4-int-Engineering work product ' + i}, ${'p4-int-eng-summary-' + i}, false)
      `;
    }
    for (let i = 0; i < 3; i++) {
      const [task] = await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
        VALUES (${bizId}, 'research-analyst', 'owner', ${'p4-int-mkt-' + i}, 'Brief', 'completed')
        RETURNING *
      `;
      await sql`
        INSERT INTO work_products (task_id, hive_id, role_slug, department, content, summary, synthesized)
        VALUES (${task.id}, ${bizId}, 'research-analyst', 'marketing', ${'p4-int-Marketing work product ' + i}, ${'p4-int-mkt-summary-' + i}, false)
      `;
    }

    expect(await shouldRunSynthesis(sql, bizId)).toBe(true);

    const config = mockModelConfig({
      hasInsight: true,
      content: "p4-int-Engineering capacity constraints may impact marketing campaign timelines",
      connectionType: "risk",
      confidence: 0.7,
      affectedDepartments: ["engineering", "marketing"],
    });

    const result = await runSynthesis(sql, bizId, config);
    expect(result.workProductsProcessed).toBeGreaterThanOrEqual(5);
    expect(result.insightsCreated).toBeGreaterThanOrEqual(1);

    const insights = await sql`SELECT * FROM insights WHERE content LIKE 'p4-int-%'`;
    expect(insights.length).toBeGreaterThanOrEqual(1);

    expect(await shouldRunSynthesis(sql, bizId)).toBe(false);
  });
});
