import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkPgvectorAvailable,
  initializeEmbeddings,
  storeEmbedding,
  findSimilar,
  chunkText,
} from "@/memory/embeddings";
import type { ModelCallerConfig } from "@/memory/model-caller";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let pgvectorAvailable = false;

beforeEach(async () => {
  await truncateAll(sql);
  pgvectorAvailable = await checkPgvectorAvailable(sql);
  if (pgvectorAvailable) {
    await initializeEmbeddings(sql);
  }
});

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkText("Short text here");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Short text here");
  });

  it("splits long text into overlapping chunks", () => {
    const longText = "word ".repeat(600);
    const chunks = chunkText(longText, 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(550);
    }
  });
});

describe("storeEmbedding", () => {
  it("stores chunk_text even without pgvector", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ embeddings: [new Array(384).fill(0.1)] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };
    const ids = await storeEmbedding(sql, {
      sourceType: "role_memory",
      sourceId: "00000000-0000-0000-0000-000000000001",
      text: "p4-emb-test embedding storage",
      modelConfig: config,
      pgvectorEnabled: pgvectorAvailable,
    });
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const rows = await sql`SELECT * FROM memory_embeddings WHERE chunk_text = 'p4-emb-test embedding storage'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].source_type).toBe("role_memory");
  });
});

describe("findSimilar", () => {
  it("returns empty array when pgvector is not available or no embeddings exist", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ embeddings: [new Array(384).fill(0.5)] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };
    const results = await findSimilar(sql, {
      queryText: "rate limit",
      sourceTypes: ["role_memory"],
      limit: 5,
      modelConfig: config,
      pgvectorEnabled: false,
    });
    expect(results).toEqual([]);
  });
});
