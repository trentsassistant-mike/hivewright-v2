import type { Sql } from "postgres";
import {
  callEmbeddingModel,
  getDefaultConfig,
  RetryableEmbeddingError,
  type ModelCallerConfig,
} from "./model-caller";
import {
  loadEmbeddingConfig,
  resetEmbeddingConfigCache,
  type EmbeddingConfigRecord,
  type EmbeddingProvider,
} from "./embedding-config";
import {
  checkPgvectorAvailable,
  ensureMemoryEmbeddingsVectorIndex,
  initializeEmbeddings,
  resetMemoryEmbeddingsForDimension,
} from "./embeddings";

const ACTIVE_REEMBEDS = new Set<string>();
const DEFAULT_BATCH_SIZE = 50;
const TRANSIENT_EMBEDDING_MAX_ATTEMPTS = 3;
const TRANSIENT_EMBEDDING_BACKOFF_MS = [250, 750] as const;

type ConfigRow = EmbeddingConfigRecord & {
  apiKey: string | null;
};

type MemoryEmbeddingRow = {
  id: string;
  source_type: string;
  source_id: string;
  chunk_text: string;
};

export interface SaveEmbeddingConfigInput {
  provider: EmbeddingProvider;
  modelName: string;
  dimension: number;
  apiCredentialKey: string | null;
  endpointOverride: string | null;
  updatedBy: string;
}

export interface SaveEmbeddingConfigResult {
  config: EmbeddingConfigRecord;
  reembedRequested: boolean;
}

export interface RunEmbeddingReembedJobOptions {
  sql: Sql;
  configId: string;
  batchSize?: number;
  embed?: (text: string, config?: ModelCallerConfig) => Promise<number[]>;
  stopAfterRows?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunEmbeddingReembedJobResult {
  status: "ready" | "error" | "noop" | "interrupted";
  processed: number;
  total: number;
  failedId?: string;
  reason?: string;
}

export interface RunReembedJobOptions {
  batchSize?: number;
  embedText?: (text: string, config?: ModelCallerConfig) => Promise<number[]>;
  stopAfterRows?: number;
}

export function startEmbeddingReembedInBackground(
  options: { sql: Sql; configId: string; batchSize?: number },
): boolean {
  if (ACTIVE_REEMBEDS.has(options.configId)) return false;
  ACTIVE_REEMBEDS.add(options.configId);
  void runEmbeddingReembedJob(options)
    .catch((err) => {
      console.error("[reembed] background job failed:", err);
    })
    .finally(() => {
      ACTIVE_REEMBEDS.delete(options.configId);
    });
  return true;
}

export async function saveEmbeddingConfigAndRequestReembed(
  input: SaveEmbeddingConfigInput,
  sql: Sql,
): Promise<SaveEmbeddingConfigResult> {
  const [existing] = await sql`
    SELECT *
    FROM embedding_config
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `;

  if (!existing) {
    const [row] = await sql`
      INSERT INTO embedding_config (
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
        updated_by
      )
      VALUES (
        ${input.provider},
        ${input.modelName},
        ${input.dimension},
        ${input.apiCredentialKey},
        ${input.endpointOverride},
        'reembedding',
        null,
        0,
        0,
        NOW(),
        null,
        null,
        ${input.updatedBy}
      )
      RETURNING *
    `;
    resetEmbeddingConfigCache();
    return { config: mapConfigRow(row), reembedRequested: true };
  }

  const changed = hasMaterialChange(existing, input);
  const completed = isCompletedConfig(existing);
  const missingEmbeddings = !changed && completed
    ? await hasMissingEmbeddings(sql)
    : false;
  const rerunNeedsReset = changed || !completed || missingEmbeddings;

  if (!changed && completed && !missingEmbeddings) {
    const [row] = await sql`
      UPDATE embedding_config
      SET updated_at = NOW(), updated_by = ${input.updatedBy}
      WHERE id = ${existing.id}
      RETURNING *
    `;
    resetEmbeddingConfigCache();
    return { config: mapConfigRow(row), reembedRequested: false };
  }

  const [row] = rerunNeedsReset
    ? await sql`
        UPDATE embedding_config
        SET
          provider = ${input.provider},
          model_name = ${input.modelName},
          dimension = ${input.dimension},
          api_credential_key = ${input.apiCredentialKey},
          endpoint_override = ${input.endpointOverride},
          status = 'reembedding',
          last_reembedded_id = null,
          reembed_total = 0,
          reembed_processed = 0,
          reembed_started_at = NOW(),
          reembed_finished_at = null,
          last_error = null,
          updated_at = NOW(),
          updated_by = ${input.updatedBy}
        WHERE id = ${existing.id}
        RETURNING *
      `
    : await sql`
        UPDATE embedding_config
        SET
          status = 'reembedding',
          reembed_started_at = COALESCE(reembed_started_at, NOW()),
          reembed_finished_at = null,
          last_error = null,
          updated_at = NOW(),
          updated_by = ${input.updatedBy}
        WHERE id = ${existing.id}
        RETURNING *
      `;

  resetEmbeddingConfigCache();
  return { config: mapConfigRow(row), reembedRequested: true };
}

export async function beginReembedRun(
  sql: Sql,
  configId: string,
  _dimension: number,
): Promise<void> {
  void _dimension;
  const total = await countMemoryEmbeddings(sql);
  await sql`
    DELETE FROM embedding_reembed_errors
    WHERE config_id = ${configId}
  `;
  await sql`
    UPDATE embedding_config
    SET
      status = 'reembedding',
      last_reembedded_id = null,
      reembed_total = ${total},
      reembed_processed = 0,
      reembed_started_at = NOW(),
      reembed_finished_at = null,
      last_error = null,
      updated_at = NOW()
    WHERE id = ${configId}
  `;
  resetEmbeddingConfigCache();
}

export async function resumeReembedRun(sql: Sql, configId: string): Promise<void> {
  const total = await countMemoryEmbeddings(sql);
  await sql`
    UPDATE embedding_config
    SET
      status = 'reembedding',
      reembed_total = ${total},
      reembed_started_at = COALESCE(reembed_started_at, NOW()),
      reembed_finished_at = null,
      last_error = null,
      updated_at = NOW()
    WHERE id = ${configId}
  `;
  resetEmbeddingConfigCache();
}

export async function runReembedJob(
  sql: Sql,
  configId: string,
  options: RunReembedJobOptions = {},
): Promise<"completed" | "interrupted"> {
  const result = await runEmbeddingReembedJob({
    sql,
    configId,
    batchSize: options.batchSize,
    embed: options.embedText,
    stopAfterRows: options.stopAfterRows,
  });

  return result.status === "interrupted" ? "interrupted" : "completed";
}

export async function runEmbeddingReembedJob(
  options: RunEmbeddingReembedJobOptions,
): Promise<RunEmbeddingReembedJobResult> {
  const { sql, configId, batchSize = DEFAULT_BATCH_SIZE } = options;
  const embed = options.embed ?? callEmbeddingModel;
  const sleep = options.sleep ?? defaultSleep;
  const config = await getConfig(sql, configId);

  if (!config) {
    return { status: "noop", processed: 0, total: 0, reason: "missing-config" };
  }
  if (config.status !== "reembedding") {
    return {
      status: "noop",
      processed: config.reembedProcessed,
      total: config.reembedTotal,
      reason: "not-requested",
    };
  }

  if (!(await checkPgvectorAvailable(sql))) {
    await markConfigTerminalState(
      sql,
      config.id,
      "error",
      config.reembedProcessed,
      config.reembedTotal,
      "pgvector extension is not available",
      config.lastReembeddedId,
    );
    resetEmbeddingConfigCache();
    return {
      status: "error",
      processed: config.reembedProcessed,
      total: config.reembedTotal,
      reason: "pgvector-unavailable",
    };
  }

  await initializeEmbeddings(sql);
  const totalAtStart = await countMemoryEmbeddings(sql);
  const freshRun = !config.lastReembeddedId && config.reembedProcessed === 0;
  const failedAtStart = await countReembedFailures(sql, config.id);

  if (freshRun) {
    await resetMemoryEmbeddingsForDimension(sql, config.dimension);
    await sql`DELETE FROM embedding_reembed_errors WHERE config_id = ${config.id}`;
  }

  let cursor = config.lastReembeddedId;
  let processed = config.reembedProcessed;

  if (!freshRun && failedAtStart > 0 && config.lastError == null) {
    await sql`DELETE FROM embedding_reembed_errors WHERE config_id = ${config.id}`;
    cursor = null;
    processed = await countEmbeddedRows(sql);
  }

  await sql`
    UPDATE embedding_config
    SET
      reembed_total = ${totalAtStart},
      last_reembedded_id = ${cursor},
      reembed_processed = ${processed},
      reembed_started_at = COALESCE(reembed_started_at, NOW()),
      reembed_finished_at = null,
      last_error = null,
      updated_at = NOW()
    WHERE id = ${config.id}
  `;

  const modelConfig = buildModelConfig(config);
  let processedThisRun = 0;

  while (true) {
    const rows = await fetchBatch(sql, config.id, cursor, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      let rowError: string | null = null;
      let rowAttempts = 1;

      try {
        const result = await embedRowWithRetry({
          text: row.chunk_text,
          modelConfig,
          embed,
          sleep,
        });
        const embedding = result.embedding;
        rowAttempts = result.attempts;
        const vector = `[${embedding.join(",")}]`;
        await sql.unsafe(
          `UPDATE memory_embeddings SET embedding = $1::vector WHERE id = $2`,
          [vector, row.id],
        );
        await sql`
          DELETE FROM embedding_reembed_errors
          WHERE config_id = ${config.id}
            AND memory_embedding_id = ${row.id}
        `;
      } catch (err) {
        rowError = err instanceof Error ? err.message : "Unknown embedding error";
        rowAttempts = getEmbeddingAttempts(err);
        await recordRowFailure(sql, config.id, row, rowError, rowAttempts);
      }

      processed += 1;
      processedThisRun += 1;
      cursor = row.id;

      await sql`
        UPDATE embedding_config
        SET
          last_reembedded_id = ${cursor},
          reembed_processed = ${processed},
          reembed_total = ${totalAtStart},
          last_error = ${rowError},
          updated_at = NOW()
        WHERE id = ${config.id}
      `;

      if (
        typeof options.stopAfterRows === "number" &&
        processedThisRun >= options.stopAfterRows
      ) {
        resetEmbeddingConfigCache();
        return {
          status: "interrupted",
          processed,
          total: totalAtStart,
          reason: "interrupted-for-test",
        };
      }
    }
  }

  await ensureMemoryEmbeddingsVectorIndex(sql);
  const failed = await countReembedFailures(sql, config.id);

  if (failed > 0) {
    await markConfigTerminalState(
      sql,
      config.id,
      "error",
      processed,
      totalAtStart,
      `${failed} row(s) failed during re-embed. See embedding_reembed_errors.`,
      cursor,
    );
    resetEmbeddingConfigCache();
    return {
      status: "error",
      processed,
      total: totalAtStart,
      reason: "row-failures",
    };
  }

  await markConfigTerminalState(sql, config.id, "ready", totalAtStart, totalAtStart, null, null);
  resetEmbeddingConfigCache();
  return { status: "ready", processed: totalAtStart, total: totalAtStart };
}

function hasMaterialChange(existing: Record<string, unknown>, next: SaveEmbeddingConfigInput): boolean {
  return (
    String(existing.provider) !== next.provider ||
    String(existing.model_name) !== next.modelName ||
    Number(existing.dimension) !== next.dimension ||
    normalizeNullable(existing.api_credential_key) !== next.apiCredentialKey ||
    normalizeNullable(existing.endpoint_override) !== next.endpointOverride
  );
}

function isCompletedConfig(existing: Record<string, unknown>): boolean {
  return (
    String(existing.status) === "ready" &&
    Number(existing.reembed_processed ?? 0) === Number(existing.reembed_total ?? 0) &&
    existing.last_error == null
  );
}

async function hasMissingEmbeddings(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ missing: number }[]>`
    SELECT COUNT(*) FILTER (WHERE embedding IS NULL)::int AS missing
    FROM memory_embeddings
  `;
  return Number(row?.missing ?? 0) > 0;
}

function normalizeNullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

async function getConfig(sql: Sql, configId: string): Promise<ConfigRow | null> {
  const [row] = await sql`
    SELECT *
    FROM embedding_config
    WHERE id = ${configId}
    LIMIT 1
  `;
  if (!row) return null;

  const config = mapConfigRow(row);
  let apiKey: string | null = null;
  try {
    const resolved = await loadEmbeddingConfig(sql);
    if (resolved.id === config.id) {
      apiKey = resolved.apiKey ?? null;
    }
  } catch {
    apiKey = null;
  }

  return {
    ...config,
    apiKey,
  };
}

function mapConfigRow(row: Record<string, unknown>): EmbeddingConfigRecord {
  return {
    id: String(row.id),
    provider: row.provider as EmbeddingProvider,
    modelName: String(row.model_name),
    dimension: Number(row.dimension),
    apiCredentialKey: row.api_credential_key ? String(row.api_credential_key) : null,
    endpointOverride: row.endpoint_override ? String(row.endpoint_override) : null,
    status: String(row.status) as EmbeddingConfigRecord["status"],
    lastReembeddedId: row.last_reembedded_id ? String(row.last_reembedded_id) : null,
    reembedTotal: Number(row.reembed_total ?? 0),
    reembedProcessed: Number(row.reembed_processed ?? 0),
    reembedStartedAt: row.reembed_started_at ? (row.reembed_started_at as string | Date) : null,
    reembedFinishedAt: row.reembed_finished_at ? (row.reembed_finished_at as string | Date) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAt: row.updated_at as string | Date,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
  };
}

function buildModelConfig(config: ConfigRow): ModelCallerConfig {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    ollamaUrl: config.endpointOverride ?? defaults.ollamaUrl,
    embeddingProvider: config.provider,
    embeddingModel: config.modelName,
    embeddingDimension: config.dimension,
    endpointOverride: config.endpointOverride,
    apiKey: config.apiKey,
  };
}

async function countMemoryEmbeddings(sql: Sql): Promise<number> {
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM memory_embeddings`;
  return Number(row?.count ?? 0);
}

async function countEmbeddedRows(sql: Sql): Promise<number> {
  const [row] = await sql`
    SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS count
    FROM memory_embeddings
  `;
  return Number(row?.count ?? 0);
}

async function countReembedFailures(sql: Sql, configId: string): Promise<number> {
  const [row] = await sql`
    SELECT COUNT(*)::int AS count
    FROM embedding_reembed_errors
    WHERE config_id = ${configId}
  `;
  return Number(row?.count ?? 0);
}

async function fetchBatch(
  sql: Sql,
  configId: string,
  cursor: string | null,
  batchSize: number,
): Promise<MemoryEmbeddingRow[]> {
  const afterCursorRows = cursor
    ? await sql<MemoryEmbeddingRow[]>`
        WITH cursor_row AS (
          SELECT created_at, id
          FROM memory_embeddings
          WHERE id = ${cursor}
        )
        SELECT me.id, me.source_type, me.source_id, me.chunk_text
        FROM memory_embeddings me
        WHERE EXISTS (SELECT 1 FROM cursor_row)
          AND EXISTS (
            SELECT 1
            FROM cursor_row c
            WHERE me.created_at > c.created_at
               OR (me.created_at = c.created_at AND me.id > c.id)
          )
          AND me.embedding IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM embedding_reembed_errors err
            WHERE err.config_id = ${configId}
              AND err.memory_embedding_id = me.id
          )
        ORDER BY me.created_at ASC, me.id ASC
        LIMIT ${batchSize}
      `
    : [];

  if (afterCursorRows.length > 0) {
    return afterCursorRows;
  }

  return sql<MemoryEmbeddingRow[]>`
    SELECT id, source_type, source_id, chunk_text
    FROM memory_embeddings
    WHERE embedding IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM embedding_reembed_errors err
        WHERE err.config_id = ${configId}
          AND err.memory_embedding_id = memory_embeddings.id
      )
    ORDER BY created_at ASC, id ASC
    LIMIT ${batchSize}
  `;
}

async function recordRowFailure(
  sql: Sql,
  configId: string,
  row: MemoryEmbeddingRow,
  errorMessage: string,
  attemptCount: number,
): Promise<void> {
  await sql`
    INSERT INTO embedding_reembed_errors (
      config_id,
      memory_embedding_id,
      source_type,
      source_id,
      chunk_text,
      error_message,
      attempt_count,
      created_at,
      updated_at
    )
    VALUES (
      ${configId},
      ${row.id},
      ${row.source_type},
      ${row.source_id},
      ${row.chunk_text},
      ${errorMessage},
      ${attemptCount},
      NOW(),
      NOW()
    )
    ON CONFLICT (config_id, memory_embedding_id)
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_id = EXCLUDED.source_id,
      chunk_text = EXCLUDED.chunk_text,
      error_message = EXCLUDED.error_message,
      attempt_count = embedding_reembed_errors.attempt_count + EXCLUDED.attempt_count,
      updated_at = NOW()
  `;
}

async function markConfigTerminalState(
  sql: Sql,
  configId: string,
  status: "ready" | "error",
  processed: number,
  total: number,
  errorMessage: string | null,
  cursor: string | null,
): Promise<void> {
  await sql`
    UPDATE embedding_config
    SET
      status = ${status},
      last_reembedded_id = ${cursor},
      reembed_processed = ${processed},
      reembed_total = ${total},
      reembed_finished_at = NOW(),
      last_error = ${errorMessage},
      updated_at = NOW()
    WHERE id = ${configId}
  `;
}

async function embedRowWithRetry(options: {
  text: string;
  modelConfig: ModelCallerConfig;
  embed: (text: string, config?: ModelCallerConfig) => Promise<number[]>;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ embedding: number[]; attempts: number }> {
  let attempt = 0;

  while (attempt < TRANSIENT_EMBEDDING_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const embedding = await options.embed(options.text, options.modelConfig);
      return { embedding, attempts: attempt };
    } catch (error) {
      if (!isRetryableEmbeddingError(error) || attempt >= TRANSIENT_EMBEDDING_MAX_ATTEMPTS) {
        throw attachEmbeddingAttempts(error, attempt);
      }

      const backoffMs = TRANSIENT_EMBEDDING_BACKOFF_MS[attempt - 1] ?? TRANSIENT_EMBEDDING_BACKOFF_MS.at(-1) ?? 0;
      if (backoffMs > 0) {
        await options.sleep(backoffMs);
      }
    }
  }

  throw attachEmbeddingAttempts(new Error("Unknown embedding error"), TRANSIENT_EMBEDDING_MAX_ATTEMPTS);
}

function isRetryableEmbeddingError(error: unknown): boolean {
  return error instanceof RetryableEmbeddingError;
}

function attachEmbeddingAttempts(error: unknown, attempts: number): Error {
  const wrapped = error instanceof Error ? error : new Error("Unknown embedding error");
  (wrapped as Error & { embeddingAttempts?: number }).embeddingAttempts = attempts;
  return wrapped;
}

function getEmbeddingAttempts(error: unknown): number {
  return (
    (error as { embeddingAttempts?: number } | null | undefined)?.embeddingAttempts
    ?? 1
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
