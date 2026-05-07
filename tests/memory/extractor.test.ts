import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildExtractionPrompt, parseExtractionResponse, extractAndStore } from "@/memory/extractor";
import type { ExtractionContext } from "@/memory/types";
import type { ModelCallerConfig } from "@/memory/model-caller";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
const TEST_TASK_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('p4-ext-test', 'P4 Extract Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;
  // role_memory has FK on role_templates.slug — seed the role first
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, priority, title, brief, qa_required)
    VALUES (${TEST_TASK_ID}, ${bizId}, 'dev-agent', 'system', 'completed', 5, 'p4-ext test task', 'test brief', false)
  `;
});

describe("buildExtractionPrompt", () => {
  it("includes work product content and existing memories", () => {
    const ctx: ExtractionContext = {
      workProductContent: "The API rate limit is 100 requests per minute.",
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      taskId: "00000000-0000-0000-0000-000000000001",
      existingRoleMemories: [
        { id: "mem-1", content: "API rate limit is 60/min", confidence: 0.8 },
      ],
      existingHiveMemories: [
        { id: "mem-2", content: "Uses NewBook API", confidence: 0.9, category: "operations" },
      ],
    };
    const prompt = buildExtractionPrompt(ctx);
    expect(prompt).toContain("100 requests per minute");
    expect(prompt).toContain("API rate limit is 60/min");
    expect(prompt).toContain("Uses NewBook API");
    expect(prompt).toContain("ADD");
    expect(prompt).toContain("UPDATE");
    expect(prompt).toContain("DELETE");
    expect(prompt).toContain("NOOP");
  });
});

describe("parseExtractionResponse", () => {
  it("parses valid JSON response into MemoryOperations", () => {
    const response = JSON.stringify({
      facts: [
        { operation: "UPDATE", store: "role_memory", existingId: "mem-1", content: "p4-ext-API rate limit is 100/min", confidence: 0.95 },
        { operation: "ADD", store: "hive_memory", content: "p4-ext-API supports batch mode", confidence: 0.8, category: "operations" },
        { operation: "NOOP", store: "hive_memory", existingId: "mem-2", reason: "Already known" },
      ],
    });
    const result = parseExtractionResponse(response);
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0].operation).toBe("UPDATE");
    expect(result.facts[1].operation).toBe("ADD");
    expect(result.facts[2].operation).toBe("NOOP");
  });

  it("handles JSON wrapped in markdown code fences", () => {
    const response = '```json\n{"facts": [{"operation": "ADD", "store": "role_memory", "content": "p4-ext-some fact", "confidence": 0.8}]}\n```';
    const result = parseExtractionResponse(response);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe("p4-ext-some fact");
  });

  it("returns empty facts for unparseable response", () => {
    const result = parseExtractionResponse("This is not JSON at all");
    expect(result.facts).toHaveLength(0);
  });
});

describe("extractAndStore", () => {
  it("calls model, parses response, and applies operations to DB", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        response: JSON.stringify({
          facts: [
            { operation: "ADD", store: "role_memory", content: "p4-ext-discovered rate limit", confidence: 0.9 },
            { operation: "ADD", store: "hive_memory", content: "p4-ext-Easter is peak season", confidence: 0.85, category: "seasonal" },
          ],
        }),
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const modelConfig: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };
    const result = await extractAndStore(sql, {
      workProductContent: "Found that the API has a rate limit of 100/min. Also Easter is the busiest period.",
      roleSlug: "dev-agent",
      hiveId: bizId,
      department: "engineering",
      taskId: "00000000-0000-0000-0000-000000000001",
      existingRoleMemories: [],
      existingHiveMemories: [],
    }, modelConfig);
    expect(result.operationResults).toHaveLength(2);
    expect(result.operationResults.every((r) => r.applied)).toBe(true);
    const roleRows = await sql`SELECT * FROM role_memory WHERE content = 'p4-ext-discovered rate limit'`;
    expect(roleRows).toHaveLength(1);
    const bizRows = await sql`SELECT * FROM hive_memory WHERE content = 'p4-ext-Easter is peak season'`;
    expect(bizRows).toHaveLength(1);
    expect(bizRows[0].category).toBe("seasonal");
  });
});
