import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseEntityExtractionResponse, extractAndStoreEntities, queryEntityGraph } from "@/memory/entity-extractor";
import type { ModelCallerConfig } from "@/memory/model-caller";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`INSERT INTO hives (slug, name, type) VALUES ('p6-entity-test', 'Entity Test', 'digital') RETURNING *`;
  bizId = biz.id;
});

describe("parseEntityExtractionResponse", () => {
  it("parses valid JSON response", () => {
    const response = JSON.stringify({
      entities: [{ name: "NewBook", type: "service", attributes: { role: "booking platform" } }],
      relationships: [{ fromEntity: "NewBook", toEntity: "Xero", relationshipType: "integrates_with", confidence: 0.9 }],
    });
    const result = parseEntityExtractionResponse(response);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("NewBook");
    expect(result.relationships).toHaveLength(1);
  });

  it("returns empty for invalid JSON", () => {
    const result = parseEntityExtractionResponse("not json");
    expect(result.entities).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
  });
});

describe("extractAndStoreEntities", () => {
  it("extracts entities from work product and stores in DB", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        response: JSON.stringify({
          entities: [
            { name: "NewBook", type: "service", attributes: { role: "booking" } },
            { name: "Xero", type: "service", attributes: { role: "accounting" } },
          ],
          relationships: [
            { fromEntity: "NewBook", toEntity: "Xero", relationshipType: "integrates_with", confidence: 0.85 },
          ],
        }),
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434", generationModel: "mistral", embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };

    const result = await extractAndStoreEntities(sql, bizId, "Integration between NewBook and Xero for booking reconciliation", null, config);
    expect(result.entitiesStored).toBe(2);
    expect(result.relationshipsStored).toBe(1);

    // Verify in DB
    const entities = await sql`SELECT * FROM entities WHERE hive_id = ${bizId}`;
    expect(entities.length).toBeGreaterThanOrEqual(2);
  });
});

describe("queryEntityGraph", () => {
  it("returns entity with connections", async () => {
    // Seed entities and relationship directly so this test is self-contained
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        response: JSON.stringify({
          entities: [
            { name: "NewBook", type: "service", attributes: { role: "booking" } },
            { name: "Xero", type: "service", attributes: { role: "accounting" } },
          ],
          relationships: [
            { fromEntity: "NewBook", toEntity: "Xero", relationshipType: "integrates_with", confidence: 0.85 },
          ],
        }),
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434", generationModel: "mistral", embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };
    await extractAndStoreEntities(sql, bizId, "Integration between NewBook and Xero", null, config);

    const result = await queryEntityGraph(sql, bizId, "NewBook");
    expect(result.entity).not.toBeNull();
    expect(result.entity!.name).toBe("NewBook");
    expect(result.connections.length).toBeGreaterThanOrEqual(1);
  });

  it("returns null entity for unknown name", async () => {
    const result = await queryEntityGraph(sql, bizId, "NonExistent");
    expect(result.entity).toBeNull();
  });
});
