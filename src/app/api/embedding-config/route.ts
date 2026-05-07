import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../_lib/auth";
import {
  getCatalogEntry,
  getEmbeddingCatalog,
  loadEmbeddingConfig,
  resetEmbeddingConfigCache,
  serializeEmbeddingConfig,
  serializeEmbeddingReembedError,
  type EmbeddingConfigRecord,
  type EmbeddingProvider,
} from "@/memory/embedding-config";
import {
  saveEmbeddingConfigAndRequestReembed,
  startEmbeddingReembedInBackground,
} from "@/memory/reembed";

interface EmbeddingConfigRequestBody {
  provider?: string;
  modelName?: string;
  dimension?: number;
  apiCredentialKey?: string | null;
  endpointOverride?: string | null;
}

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    const config = await loadEmbeddingConfig(sql);
    const { errorSummary, recentErrors } = config.id === "fallback"
      ? { errorSummary: null, recentErrors: [] }
      : await loadErrorState(config.id);
    return jsonOk({
      config: config.id === "fallback" ? null : serializeConfigPayload(config, errorSummary),
      catalog: getEmbeddingCatalog(),
      errorSummary,
      recentErrors,
    });
  } catch (err) {
    console.error("[embedding-config GET] failed:", err);
    return jsonError("Failed to load embedding config", 500);
  }
}

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json() as EmbeddingConfigRequestBody;
    const provider = body.provider?.trim();
    const modelName = body.modelName?.trim();
    const apiCredentialKey = normalizeNullableString(body.apiCredentialKey);
    const endpointOverride = normalizeNullableString(body.endpointOverride);
    const dimension = Number(body.dimension);

    if (!provider || !modelName || !Number.isFinite(dimension)) {
      return jsonError("provider, modelName, and dimension are required", 400);
    }

    const catalogEntry = getCatalogEntry(provider, modelName);
    if (!catalogEntry) {
      return jsonError("Unsupported embedding provider/model selection", 400);
    }
    if (catalogEntry.dimension !== dimension) {
      return jsonError(
        `Dimension mismatch for ${provider}/${modelName}: expected ${catalogEntry.dimension}, received ${dimension}`,
        400,
      );
    }

    const [current] = await sql`
      SELECT *
      FROM embedding_config
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `;
    if (current && String(current.status) === "reembedding") {
      return jsonError("A re-embed run is already in progress", 409);
    }

    const persisted = await saveEmbeddingConfigAndRequestReembed({
      provider: provider as EmbeddingProvider,
      modelName,
      dimension,
      apiCredentialKey,
      endpointOverride,
      updatedBy: authz.user.email,
    }, sql);

    resetEmbeddingConfigCache();
    if (persisted.reembedRequested && process.env.VITEST !== "true") {
      startEmbeddingReembedInBackground({ sql, configId: persisted.config.id });
    }
    const { errorSummary, recentErrors } = await loadErrorState(persisted.config.id);
    return jsonOk({
      config: serializeConfigPayload(
        persisted.config,
        errorSummary,
        persisted.reembedRequested
          && persisted.config.reembedProcessed === 0
          && persisted.config.lastReembeddedId == null
          ? 0
          : persisted.config.reembedTotal,
      ),
      catalog: getEmbeddingCatalog(),
      errorSummary,
      recentErrors,
      reembedRequested: persisted.reembedRequested,
    });
  } catch (err) {
    console.error("[embedding-config POST] failed:", err);
    return jsonError("Failed to save embedding config", 500);
  }
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function loadErrorState(configId: string) {
  const errors = await sql`
    SELECT
      id,
      config_id,
      memory_embedding_id,
      source_type,
      source_id,
      chunk_text,
      error_message,
      attempt_count,
      updated_at
    FROM embedding_reembed_errors
    WHERE config_id = ${configId}
    ORDER BY updated_at DESC
    LIMIT 10
  `;
  const [countRow] = await sql`
    SELECT COUNT(*)::int AS count
    FROM embedding_reembed_errors
    WHERE config_id = ${configId}
  `;
  const count = Number(countRow?.count ?? 0);

  return {
    errorSummary: count > 0
      ? {
          count,
          latestMessage: errors[0]?.error_message ? String(errors[0].error_message) : null,
        }
      : null,
    recentErrors: errors.map((row) =>
      serializeEmbeddingReembedError({
        id: String(row.id),
        configId: String(row.config_id),
        memoryEmbeddingId: String(row.memory_embedding_id),
        sourceType: String(row.source_type),
        sourceId: String(row.source_id),
        chunkText: String(row.chunk_text),
        errorMessage: String(row.error_message),
        attemptCount: Number(row.attempt_count),
        updatedAt: row.updated_at as string | Date,
      }),
    ),
  };
}

function serializeConfigPayload(
  config: EmbeddingConfigRecord | Awaited<ReturnType<typeof loadEmbeddingConfig>>,
  errorSummary: { count: number; latestMessage: string | null } | null,
  progressTotal = config.reembedTotal,
) {
  return {
    ...serializeEmbeddingConfig(config),
    progress: {
      processed: config.reembedProcessed,
      total: progressTotal,
      failed: errorSummary?.count ?? 0,
      cursor: config.lastReembeddedId,
      errorSummary,
    },
    errorSummary,
  };
}
