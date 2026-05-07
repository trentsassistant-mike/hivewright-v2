import type { Sql } from "postgres";
import { callEmbeddingModel, type ModelCallerConfig, getDefaultConfig } from "./model-caller";
import { loadEmbeddingConfig } from "./embedding-config";

export const MEMORY_EMBEDDINGS_VECTOR_INDEX = "idx_memory_embeddings_embedding";

export async function checkPgvectorAvailable(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function initializeEmbeddings(sql: Sql): Promise<boolean> {
  try {
    const config = await loadEmbeddingConfig(sql);
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql.unsafe(
      `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding vector(${config.dimension})`
    );
    await ensureMemoryEmbeddingsVectorIndex(sql);
    return true;
  } catch (err) {
    console.warn("[embeddings] Failed to initialize pgvector:", err);
    return false;
  }
}

export async function resetMemoryEmbeddingsForDimension(sql: Sql, dimension: number): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql.unsafe(`ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding vector(${dimension})`);
  await sql.unsafe(`ALTER TABLE memory_embeddings ALTER COLUMN embedding TYPE vector(${dimension}) USING NULL`);
  await rebuildMemoryEmbeddingsVectorIndex(sql);
}

export async function rebuildMemoryEmbeddingsVectorIndex(sql: Sql): Promise<void> {
  await sql.unsafe(`DROP INDEX IF EXISTS ${MEMORY_EMBEDDINGS_VECTOR_INDEX}`);
  await ensureMemoryEmbeddingsVectorIndex(sql);
}

export async function ensureMemoryEmbeddingsVectorIndex(sql: Sql): Promise<void> {
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS ${MEMORY_EMBEDDINGS_VECTOR_INDEX}
     ON memory_embeddings
     USING ivfflat (embedding vector_cosine_ops)
     WITH (lists = 100)`
  );
}

export function chunkText(
  text: string,
  maxChunkChars: number = 500,
  overlapChars: number = 50,
): string[] {
  if (text.length <= maxChunkChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChunkChars;
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start + maxChunkChars / 2) {
        end = lastSpace;
      }
    } else {
      end = text.length;
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlapChars;
    if (start >= text.length - overlapChars) break;
  }
  return chunks.filter((c) => c.length > 0);
}

export interface StoreEmbeddingInput {
  sourceType: string;
  sourceId: string;
  hiveId?: string;
  text: string;
  modelConfig?: ModelCallerConfig;
  pgvectorEnabled: boolean;
}

export async function storeEmbedding(
  sql: Sql,
  input: StoreEmbeddingInput,
): Promise<string[]> {
  const config = input.modelConfig ?? await getEmbeddingModelConfig(sql);
  const chunks = chunkText(input.text);
  const ids: string[] = [];
  for (const chunk of chunks) {
    if (input.pgvectorEnabled) {
      try {
        const embedding = await callEmbeddingModel(chunk, config);
        const vectorStr = `[${embedding.join(",")}]`;
        const [row] = await sql.unsafe(
          `INSERT INTO memory_embeddings (source_type, source_id, hive_id, chunk_text, embedding)
           VALUES ($1, $2, $3, $4, $5::vector) RETURNING id`,
          [input.sourceType, input.sourceId, input.hiveId ?? null, chunk, vectorStr]
        );
        ids.push(row.id);
      } catch (err) {
        console.warn("[embeddings] Vector storage failed, storing text only:", err);
        const [row] = await sql`
          INSERT INTO memory_embeddings (source_type, source_id, hive_id, chunk_text)
          VALUES (${input.sourceType}, ${input.sourceId}, ${input.hiveId ?? null}, ${chunk})
          RETURNING id
        `;
        ids.push(row.id);
      }
    } else {
      const [row] = await sql`
        INSERT INTO memory_embeddings (source_type, source_id, hive_id, chunk_text)
        VALUES (${input.sourceType}, ${input.sourceId}, ${input.hiveId ?? null}, ${chunk})
        RETURNING id
      `;
      ids.push(row.id);
    }
  }
  return ids;
}

export interface SimilaritySearchInput {
  queryText: string;
  sourceTypes: string[];
  limit: number;
  modelConfig?: ModelCallerConfig;
  pgvectorEnabled: boolean;
  hiveId?: string;
}

export interface SimilarityResult {
  id: string;
  sourceType: string;
  sourceId: string;
  chunkText: string;
  distance: number;
}

export async function findSimilar(
  sql: Sql,
  input: SimilaritySearchInput,
): Promise<SimilarityResult[]> {
  if (!input.pgvectorEnabled) return [];
  const config = input.modelConfig ?? await getEmbeddingModelConfig(sql);
  let queryEmbedding: number[];
  try {
    queryEmbedding = await callEmbeddingModel(input.queryText, config);
  } catch {
    return [];
  }
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  try {
    const hiveFilter = input.hiveId
      ? `AND hive_id = $4`
      : "";
    const params: unknown[] = [vectorStr, input.sourceTypes, input.limit];
    if (input.hiveId) params.push(input.hiveId);
    const rows = await sql.unsafe(
      `SELECT id, source_type, source_id, chunk_text,
              embedding <=> $1::vector AS distance
       FROM memory_embeddings
       WHERE source_type = ANY($2)
         AND embedding IS NOT NULL
         ${hiveFilter}
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $3`,
      params as Parameters<typeof sql.unsafe>[1]
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      sourceType: (r.source_type ?? r["sourceType"]) as string,
      sourceId: (r.source_id ?? r["sourceId"]) as string,
      chunkText: (r.chunk_text ?? r["chunkText"]) as string,
      distance: Number(r.distance),
    }));
  } catch {
    return [];
  }
}

export async function deleteEmbeddings(sql: Sql, sourceType: string, sourceId: string): Promise<void> {
  await sql`DELETE FROM memory_embeddings WHERE source_type = ${sourceType} AND source_id = ${sourceId}`;
}

async function getEmbeddingModelConfig(sql: Sql): Promise<ModelCallerConfig> {
  const config = await loadEmbeddingConfig(sql);
  return {
    ...getDefaultConfig(),
    ollamaUrl: config.endpointOverride ?? getDefaultConfig().ollamaUrl,
    embeddingProvider: config.provider,
    embeddingModel: config.modelName,
    embeddingDimension: config.dimension,
    endpointOverride: config.endpointOverride,
    apiKey: config.apiKey,
  };
}
