import { beforeEach, describe, expect, it, vi } from "vitest";
import { findSimilar } from "../../src/memory/embeddings";
import { resetEmbeddingConfigCache } from "../../src/memory/embedding-config";
import { RetryableEmbeddingError } from "../../src/memory/model-caller";
import {
  beginReembedRun,
  resumeReembedRun,
  runEmbeddingReembedJob,
  runReembedJob,
} from "../../src/memory/reembed";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const CONFIG_ID = "00000000-0000-0000-0000-0000000000c1";
beforeEach(async () => {
  await truncateAll(sql);
  resetEmbeddingConfigCache();

  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`
    INSERT INTO embedding_config (
      id,
      provider,
      model_name,
      dimension,
      api_credential_key,
      endpoint_override,
      status,
      last_reembedded_id,
      reembed_total,
      reembed_processed,
      updated_by
    )
    VALUES (
      ${CONFIG_ID},
      'openrouter',
      'openai/text-embedding-3-small',
      1536,
      'OPENROUTER_API_KEY',
      'https://openrouter.ai/api/v1',
      'ready',
      null,
      0,
      0,
      'test@local'
    )
  `;
});

describe("runReembedJob", () => {
  it("resumes from last_reembedded_id without reprocessing completed rows", async () => {
    await seedMemoryRows(["alpha", "bravo", "charlie"]);
    await beginReembedRun(sql, CONFIG_ID, 1536);

    const embedText = vi.fn(async (text: string) => buildEmbedding(text.length));

    const firstRun = await runReembedJob(sql, CONFIG_ID, {
      embedText,
      stopAfterRows: 2,
    });
    expect(firstRun).toBe("interrupted");

    const [interrupted] = await sql`
      SELECT status, reembed_processed, reembed_total, last_reembedded_id
      FROM embedding_config
      WHERE id = ${CONFIG_ID}
    `;
    expect(interrupted.status).toBe("reembedding");
    expect(interrupted.reembed_processed).toBe(2);
    expect(interrupted.reembed_total).toBe(3);
    expect(interrupted.last_reembedded_id).toBeTruthy();

    await resumeReembedRun(sql, CONFIG_ID);
    const secondRun = await runReembedJob(sql, CONFIG_ID, { embedText });
    expect(secondRun).toBe("completed");
    expect(embedText).toHaveBeenCalledTimes(3);

    const [completed] = await sql`
      SELECT status, reembed_processed, reembed_total
      FROM embedding_config
      WHERE id = ${CONFIG_ID}
    `;
    expect(completed.status).toBe("ready");
    expect(completed.reembed_processed).toBe(3);
    expect(completed.reembed_total).toBe(3);

    const [{ embedded }] = await sql<{ embedded: string }[]>`
      SELECT COUNT(*)::text AS embedded
      FROM memory_embeddings
      WHERE embedding IS NOT NULL
    `;
    expect(Number(embedded)).toBe(3);
  });

  it("records per-row failures with triage fields and leaves search working for successful rows", async () => {
    await seedMemoryRows(["findable", "broken"]);
    await beginReembedRun(sql, CONFIG_ID, 1536);

    const embedText = vi.fn(async (text: string) => {
      if (text === "broken") {
        throw new Error("synthetic embedding failure");
      }
      return buildEmbedding(7);
    });

    const outcome = await runEmbeddingReembedJob({
      sql,
      configId: CONFIG_ID,
      embed: embedText,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.processed).toBe(2);
    expect(outcome.total).toBe(2);

    const [errorRow] = await sql`
      SELECT source_type, source_id, chunk_text, error_message, attempt_count
      FROM embedding_reembed_errors
      WHERE config_id = ${CONFIG_ID}
      LIMIT 1
    `;
    expect(errorRow.source_type).toBe("note");
    expect(errorRow.source_id).toBe("00000000-0000-0000-0000-0000000000b2");
    expect(errorRow.chunk_text).toBe("broken");
    expect(errorRow.error_message).toMatch(/synthetic embedding failure/i);
    expect(errorRow.attempt_count).toBe(1);

    const results = await findSimilar(sql, {
      queryText: "findable",
      sourceTypes: ["note"],
      limit: 5,
      pgvectorEnabled: true,
      modelConfig: {
        ollamaUrl: "http://localhost:11434",
        generationModel: "mistral",
        embeddingModel: "openai/text-embedding-3-small",
        embeddingProvider: "openrouter",
        embeddingDimension: 1536,
        endpointOverride: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        fetchFn: vi.fn(async () =>
          new Response(
            JSON.stringify({
              data: [{ embedding: buildEmbedding(7) }],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      },
    });

    expect(results.some((row) => row.chunkText === "findable")).toBe(true);
    expect(results.some((row) => row.chunkText === "broken")).toBe(false);
  });

  it("retries transient malformed embedding responses and succeeds deterministically", async () => {
    await seedMemoryRows(["recoverable"]);
    await beginReembedRun(sql, CONFIG_ID, 1536);

    const sleep = vi.fn(async () => {});
    const embedText = vi.fn(async () => {
      if (embedText.mock.calls.length < 3) {
        throw new RetryableEmbeddingError("OpenRouter returned empty or malformed embedding response");
      }
      return buildEmbedding(11);
    });

    const result = await runEmbeddingReembedJob({
      sql,
      configId: CONFIG_ID,
      embed: embedText,
      sleep,
    });

    expect(result).toEqual({
      status: "ready",
      processed: 1,
      total: 1,
    });
    expect(embedText).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 750);

    const errors = await sql`
      SELECT *
      FROM embedding_reembed_errors
      WHERE config_id = ${CONFIG_ID}
    `;
    expect(errors).toHaveLength(0);
  });

  it("allows an explicit rerun to recover rows that previously failed with malformed responses", async () => {
    await seedMemoryRows(["alpha", "bravo"]);
    await beginReembedRun(sql, CONFIG_ID, 1536);

    const firstRunEmbed = vi.fn(async (text: string) => {
      if (text === "bravo") {
        throw new RetryableEmbeddingError("OpenRouter returned empty or malformed embedding response");
      }
      return buildEmbedding(13);
    });

    const firstResult = await runEmbeddingReembedJob({
      sql,
      configId: CONFIG_ID,
      embed: firstRunEmbed,
      sleep: async () => {},
    });
    expect(firstResult.status).toBe("error");

    const [failedState] = await sql`
      SELECT status, reembed_processed, reembed_total, last_error
      FROM embedding_config
      WHERE id = ${CONFIG_ID}
    `;
    expect(failedState.status).toBe("error");
    expect(failedState.reembed_processed).toBe(2);
    expect(failedState.reembed_total).toBe(2);
    expect(String(failedState.last_error)).toMatch(/failed during re-embed/i);

    const [errorRow] = await sql`
      SELECT chunk_text, attempt_count, error_message
      FROM embedding_reembed_errors
      WHERE config_id = ${CONFIG_ID}
    `;
    expect(errorRow.chunk_text).toBe("bravo");
    expect(errorRow.attempt_count).toBe(3);
    expect(String(errorRow.error_message)).toMatch(/malformed embedding response/i);

    await resumeReembedRun(sql, CONFIG_ID);
    const secondRunEmbed = vi.fn(async () => buildEmbedding(17));
    const secondResult = await runEmbeddingReembedJob({
      sql,
      configId: CONFIG_ID,
      embed: secondRunEmbed,
      sleep: async () => {},
    });

    expect(secondResult).toEqual({
      status: "ready",
      processed: 2,
      total: 2,
    });
    expect(secondRunEmbed).toHaveBeenCalledTimes(1);

    const [recoveredState] = await sql`
      SELECT status, reembed_processed, reembed_total, last_error, last_reembedded_id
      FROM embedding_config
      WHERE id = ${CONFIG_ID}
    `;
    expect(recoveredState.status).toBe("ready");
    expect(recoveredState.reembed_processed).toBe(2);
    expect(recoveredState.reembed_total).toBe(2);
    expect(recoveredState.last_error).toBeNull();
    expect(recoveredState.last_reembedded_id).toBeNull();

    const remainingErrors = await sql`
      SELECT *
      FROM embedding_reembed_errors
      WHERE config_id = ${CONFIG_ID}
    `;
    expect(remainingErrors).toHaveLength(0);
  });

  it("migrates vector dimension without losing chunk text and noops after completion", async () => {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql.unsafe(`ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding vector(768)`);
    await sql.unsafe(`ALTER TABLE memory_embeddings ALTER COLUMN embedding TYPE vector(768) USING NULL`);

    const oldAlpha = `[${Array.from({ length: 768 }, (_, index) => (100 + index) / 10_000).join(",")}]`;
    const oldBravo = `[${Array.from({ length: 768 }, (_, index) => (200 + index) / 10_000).join(",")}]`;

    await sql.unsafe(
      `INSERT INTO memory_embeddings (source_type, source_id, chunk_text, embedding)
       VALUES ($1, $2, $3, $4::vector), ($5, $6, $7, $8::vector)`,
      [
        "note",
        "00000000-0000-0000-0000-0000000000b1",
        "alpha migration target",
        oldAlpha,
        "note",
        "00000000-0000-0000-0000-0000000000b2",
        "bravo migration target",
        oldBravo,
      ],
    );

    await beginReembedRun(sql, CONFIG_ID, 1536);

    const embedText = vi.fn(async (text: string) => buildSemanticEmbedding(text));

    const result = await runEmbeddingReembedJob({
      sql,
      configId: CONFIG_ID,
      embed: embedText,
    });

    expect(result).toEqual({
      status: "ready",
      processed: 2,
      total: 2,
    });

    const rows = await sql<{
      chunk_text: string;
      dimensions: number;
      has_embedding: boolean;
    }[]>`
      SELECT
        chunk_text,
        vector_dims(embedding) AS dimensions,
        embedding IS NOT NULL AS has_embedding
      FROM memory_embeddings
      ORDER BY chunk_text ASC
    `;
    expect(rows).toEqual([
      {
        chunk_text: "alpha migration target",
        dimensions: 1536,
        has_embedding: true,
      },
      {
        chunk_text: "bravo migration target",
        dimensions: 1536,
        has_embedding: true,
      },
    ]);

    const searchResults = await findSimilar(sql, {
      queryText: "alpha migration target",
      sourceTypes: ["note"],
      limit: 2,
      pgvectorEnabled: true,
      modelConfig: {
        ollamaUrl: "http://localhost:11434",
        generationModel: "mistral",
        embeddingModel: "openai/text-embedding-3-small",
        embeddingProvider: "openrouter",
        embeddingDimension: 1536,
        endpointOverride: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        fetchFn: vi.fn(async (_url, init) => {
          const payload = JSON.parse(String(init?.body)) as { input: string };
          return new Response(
            JSON.stringify({
              data: [{ embedding: buildSemanticEmbedding(payload.input) }],
            }),
            { status: 200 },
          );
        }),
      },
    });

    expect(searchResults[0]?.chunkText).toBe("alpha migration target");

    const rerun = await runEmbeddingReembedJob({
      sql,
      configId: CONFIG_ID,
      embed: embedText,
    });
    expect(rerun).toEqual({
      status: "noop",
      processed: 2,
      total: 2,
      reason: "not-requested",
    });
    expect(embedText).toHaveBeenCalledTimes(2);
  });
});

async function seedMemoryRows(chunks: string[]): Promise<void> {
  const sourceIds = [
    "00000000-0000-0000-0000-0000000000b1",
    "00000000-0000-0000-0000-0000000000b2",
    "00000000-0000-0000-0000-0000000000b3",
  ];

  for (const [index, chunk] of chunks.entries()) {
    await sql`
      INSERT INTO memory_embeddings (source_type, source_id, chunk_text)
      VALUES ('note', ${sourceIds[index]}, ${chunk})
    `;
  }
}

function buildEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, index) => (seed + index) / 10_000);
}

function buildSemanticEmbedding(text: string): number[] {
  const base = text.startsWith("alpha") ? 0.1 : 0.2;
  return Array.from({ length: 1536 }, (_, index) => {
    if (index === 0) return base;
    if (index === 1) return text.length / 1_000;
    return 0;
  });
}
