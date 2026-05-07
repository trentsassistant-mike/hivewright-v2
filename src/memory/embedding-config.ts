import type { Sql } from "postgres";
import { getProviderEndpoint } from "@/adapters/provider-config";
import { sql as db } from "@/app/api/_lib/db";
import { loadCredentials } from "@/credentials/manager";

export const EMBEDDING_PROVIDERS = [
  "ollama",
  "openai",
  "voyage",
  "cohere",
  "mistral",
  "google",
  "huggingface",
  "openrouter",
] as const;

export type EmbeddingProvider = typeof EMBEDDING_PROVIDERS[number];
export type EmbeddingConfigStatus = "ready" | "reembedding" | "error";

export interface EmbeddingCatalogEntry {
  modelName: string;
  dimension: number;
}

export interface EmbeddingCatalogProvider {
  provider: EmbeddingProvider;
  label: string;
  models: EmbeddingCatalogEntry[];
}

export interface EmbeddingConfigRecord {
  id: string;
  provider: EmbeddingProvider;
  modelName: string;
  dimension: number;
  apiCredentialKey: string | null;
  endpointOverride: string | null;
  status: EmbeddingConfigStatus;
  lastReembeddedId: string | null;
  reembedTotal: number;
  reembedProcessed: number;
  reembedStartedAt: string | Date | null;
  reembedFinishedAt: string | Date | null;
  lastError: string | null;
  updatedAt: string | Date;
  updatedBy: string | null;
}

export interface ResolvedEmbeddingConfig extends EmbeddingConfigRecord {
  apiKey: string | null;
}

export interface EmbeddingReembedErrorRecord {
  id: string;
  configId: string;
  memoryEmbeddingId: string;
  sourceType: string;
  sourceId: string;
  chunkText: string;
  errorMessage: string;
  attemptCount: number;
  updatedAt: string | Date;
}

export const EMBEDDING_CATALOG: readonly EmbeddingCatalogProvider[] = [
  {
    provider: "ollama",
    label: "Ollama",
    models: [
      { modelName: "all-minilm", dimension: 768 },
      { modelName: "nomic-embed-text", dimension: 768 },
      { modelName: "mxbai-embed-large", dimension: 1024 },
      { modelName: "bge-large", dimension: 1024 },
    ],
  },
  {
    provider: "openai",
    label: "OpenAI",
    models: [
      { modelName: "text-embedding-3-small", dimension: 1536 },
      { modelName: "text-embedding-3-large", dimension: 3072 },
    ],
  },
  {
    provider: "voyage",
    label: "Voyage",
    models: [
      { modelName: "voyage-3-lite", dimension: 512 },
      { modelName: "voyage-3", dimension: 1024 },
      { modelName: "voyage-3-large", dimension: 1024 },
      { modelName: "voyage-code-3", dimension: 1024 },
    ],
  },
  {
    provider: "cohere",
    label: "Cohere",
    models: [
      { modelName: "embed-v4.0", dimension: 1536 },
      { modelName: "embed-english-v3.0", dimension: 1024 },
      { modelName: "embed-multilingual-v3.0", dimension: 1024 },
    ],
  },
  {
    provider: "mistral",
    label: "Mistral",
    models: [
      { modelName: "mistral-embed", dimension: 1024 },
    ],
  },
  {
    provider: "google",
    label: "Google",
    models: [
      { modelName: "text-embedding-005", dimension: 768 },
      { modelName: "gemini-embedding-001", dimension: 3072 },
    ],
  },
  {
    provider: "huggingface",
    label: "HuggingFace",
    models: [
      { modelName: "BAAI/bge-large-en-v1.5", dimension: 1024 },
      { modelName: "intfloat/e5-large-v2", dimension: 1024 },
      { modelName: "sentence-transformers/all-MiniLM-L6-v2", dimension: 384 },
    ],
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    models: [
      { modelName: "openai/text-embedding-3-small", dimension: 1536 },
      { modelName: "openai/text-embedding-3-large", dimension: 3072 },
      { modelName: "google/gemini-embedding-001", dimension: 3072 },
    ],
  },
] as const;

const CACHE_TTL_MS = 60_000;
const SYSTEM_HIVE_ID = "00000000-0000-0000-0000-000000000000";

let cachedConfig: { expiresAt: number; value: ResolvedEmbeddingConfig } | null = null;

function getDefaultModel(provider: EmbeddingProvider): EmbeddingCatalogEntry {
  const catalog = EMBEDDING_CATALOG.find((entry) => entry.provider === provider);
  if (!catalog?.models[0]) {
    throw new Error(`No embedding catalog configured for provider '${provider}'`);
  }
  return catalog.models[0];
}

export function getEmbeddingCatalog(): readonly EmbeddingCatalogProvider[] {
  return EMBEDDING_CATALOG;
}

export function getCatalogEntry(
  provider: string,
  modelName: string,
): EmbeddingCatalogEntry | null {
  const catalog = EMBEDDING_CATALOG.find((entry) => entry.provider === provider);
  if (!catalog) return null;
  return catalog.models.find((entry) => entry.modelName === modelName) ?? null;
}

export function getFallbackEmbeddingConfig(): ResolvedEmbeddingConfig {
  const provider: EmbeddingProvider = "ollama";
  const fallbackModelName = process.env.OLLAMA_EMBEDDING_MODEL || "all-minilm";
  const catalogEntry = getCatalogEntry(provider, fallbackModelName) ?? getDefaultModel(provider);
  const dimension = Number(process.env.OLLAMA_EMBEDDING_DIMENSION || catalogEntry.dimension);

  return {
    id: "fallback",
    provider,
    modelName: fallbackModelName,
    dimension: Number.isFinite(dimension) && dimension > 0 ? dimension : catalogEntry.dimension,
    apiCredentialKey: null,
    endpointOverride: getProviderEndpoint("ollama") ?? "http://localhost:11434",
    status: "ready",
    lastReembeddedId: null,
    reembedTotal: 0,
    reembedProcessed: 0,
    reembedStartedAt: null,
    reembedFinishedAt: null,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    updatedBy: "env:fallback",
    apiKey: null,
  };
}

async function loadApiKey(
  sql: Sql,
  apiCredentialKey: string | null,
): Promise<string | null> {
  if (!apiCredentialKey) return null;
  const encryptionKey = process.env.ENCRYPTION_KEY || "";
  if (!encryptionKey) return null;

  const creds = await loadCredentials(sql, {
    hiveId: SYSTEM_HIVE_ID,
    requiredKeys: [apiCredentialKey],
    roleSlug: "memory",
    encryptionKey,
  });
  return (creds as Record<string, string>)[apiCredentialKey] ?? null;
}

export async function loadEmbeddingConfig(
  sql: Sql = db,
): Promise<ResolvedEmbeddingConfig> {
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.value;
  }

  let row:
    | Record<string, unknown>
    | undefined;
  try {
    [row] = await sql`
      SELECT
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
        reembed_started_at,
        reembed_finished_at,
        last_error,
        updated_at,
        updated_by
      FROM embedding_config
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01") {
      const fallback = getFallbackEmbeddingConfig();
      cachedConfig = { value: fallback, expiresAt: Date.now() + CACHE_TTL_MS };
      return fallback;
    }
    throw err;
  }

  if (!row) {
    const fallback = getFallbackEmbeddingConfig();
    cachedConfig = { value: fallback, expiresAt: Date.now() + CACHE_TTL_MS };
    return fallback;
  }

  const resolved: ResolvedEmbeddingConfig = {
    id: String(row.id),
    provider: row.provider as EmbeddingProvider,
    modelName: String(row.model_name),
    dimension: Number(row.dimension),
    apiCredentialKey: row.api_credential_key ? String(row.api_credential_key) : null,
    endpointOverride: row.endpoint_override ? String(row.endpoint_override) : null,
    status: (row.status ?? "ready") as EmbeddingConfigStatus,
    lastReembeddedId: row.last_reembedded_id ? String(row.last_reembedded_id) : null,
    reembedTotal: Number(row.reembed_total ?? 0),
    reembedProcessed: Number(row.reembed_processed ?? 0),
    reembedStartedAt: row.reembed_started_at ? (row.reembed_started_at instanceof Date ? row.reembed_started_at : String(row.reembed_started_at)) : null,
    reembedFinishedAt: row.reembed_finished_at ? (row.reembed_finished_at instanceof Date ? row.reembed_finished_at : String(row.reembed_finished_at)) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : String(row.updated_at),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    apiKey: await loadApiKey(sql, row.api_credential_key ? String(row.api_credential_key) : null),
  };

  cachedConfig = { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  return resolved;
}

export function serializeEmbeddingConfig(config: EmbeddingConfigRecord | ResolvedEmbeddingConfig) {
  return {
    id: config.id,
    provider: config.provider,
    modelName: config.modelName,
    dimension: config.dimension,
    apiCredentialKey: config.apiCredentialKey,
    endpointOverride: config.endpointOverride,
    status: config.status,
    lastReembeddedId: config.lastReembeddedId,
    reembedTotal: config.reembedTotal,
    reembedProcessed: config.reembedProcessed,
    reembedStartedAt: config.reembedStartedAt,
    reembedFinishedAt: config.reembedFinishedAt,
    lastError: config.lastError,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
}

export function resetEmbeddingConfigCache(): void {
  cachedConfig = null;
}

export function serializeEmbeddingReembedError(error: EmbeddingReembedErrorRecord) {
  return {
    id: error.id,
    configId: error.configId,
    memoryEmbeddingId: error.memoryEmbeddingId,
    sourceType: error.sourceType,
    sourceId: error.sourceId,
    chunkText: error.chunkText,
    errorMessage: error.errorMessage,
    attemptCount: error.attemptCount,
    updatedAt: error.updatedAt,
  };
}
