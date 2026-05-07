import type { Sql } from "postgres";
import { decrypt } from "@/credentials/encryption";
import {
  discoverModelsForAdapter,
  discoveryConfigForAdapter,
} from "@/model-discovery/providers";
import { runModelDiscoveryImport } from "@/model-discovery/service";

const CLOUD_DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OLLAMA_DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SUPPORTED_DISCOVERY_ADAPTERS = ["codex", "gemini", "claude-code", "ollama"] as const;

type SupportedDiscoveryAdapter = typeof SUPPORTED_DISCOVERY_ADAPTERS[number];

interface ShouldRunModelDiscoveryInput {
  adapterType: string;
  lastStartedAt: Date | null;
  now?: Date;
}

interface ModelDiscoveryCandidateRow {
  hive_id: string;
  adapter_type: SupportedDiscoveryAdapter;
  credential_id: string | null;
  last_started_at: Date | null;
}

interface CredentialRow {
  id: string;
  hive_id: string | null;
  key: string;
  value: string;
}

export interface ScheduledModelDiscoveryResult {
  candidates: number;
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface ScheduledModelDiscoveryOptions {
  now?: Date;
  logger?: Pick<Console, "error" | "log">;
  onLockAcquired?: (
    candidate: Pick<ModelDiscoveryCandidateRow, "hive_id" | "adapter_type" | "credential_id">,
  ) => Promise<void> | void;
}

export function shouldRunModelDiscovery(input: ShouldRunModelDiscoveryInput): boolean {
  if (!input.lastStartedAt) return true;

  const now = input.now ?? new Date();
  const elapsedMs = now.getTime() - input.lastStartedAt.getTime();
  if (elapsedMs < 0) return false;

  return elapsedMs >= discoveryIntervalMs(input.adapterType);
}

export async function runScheduledModelDiscovery(
  sql: Sql,
  options: ScheduledModelDiscoveryOptions = {},
): Promise<ScheduledModelDiscoveryResult> {
  const now = options.now ?? new Date();
  const logger = options.logger ?? console;
  const candidates = await findModelDiscoveryCandidates(sql);
  const result: ScheduledModelDiscoveryResult = {
    candidates: candidates.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    if (!shouldRunModelDiscovery({
      adapterType: candidate.adapter_type,
      lastStartedAt: candidate.last_started_at,
      now,
    })) {
      continue;
    }

    const lockKey = modelDiscoveryLockKey(candidate);
    const releaseLock = await acquireModelDiscoveryLock(sql, lockKey);
    if (!releaseLock) continue;

    let provider = providerForAdapter(candidate.adapter_type);
    let source = "scheduled_model_discovery";

    try {
      await options.onLockAcquired?.(candidate);
      const latestStartedAt = await loadLastModelDiscoveryStartedAt(sql, candidate);
      if (!shouldRunModelDiscovery({
        adapterType: candidate.adapter_type,
        lastStartedAt: latestStartedAt,
        now,
      })) {
        continue;
      }

      result.attempted += 1;

      const discoveryConfig = discoveryConfigForAdapter({
        adapterType: candidate.adapter_type,
        provider: null,
      });
      provider = discoveryConfig.provider;
      source = discoveryConfig.source;

      const credentials = await loadDiscoveryCredentials(sql, {
        hiveId: candidate.hive_id,
        adapterType: discoveryConfig.adapterType,
        credentialId: candidate.credential_id,
      });
      const discoveryInput = {
        adapterType: discoveryConfig.adapterType,
        provider: discoveryConfig.provider,
        ...(credentials ? { credentials } : {}),
      };
      const models = await discoverModelsForAdapter(discoveryInput);

      await runModelDiscoveryImport(sql, {
        hiveId: candidate.hive_id,
        adapterType: discoveryConfig.adapterType,
        provider: discoveryConfig.provider,
        credentialId: candidate.credential_id,
        assignCredentialToHiveModels: false,
        source: discoveryConfig.source,
        models,
      });
      result.succeeded += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(
        `[dispatcher] Scheduled model discovery failed for hive ${candidate.hive_id} adapter ${candidate.adapter_type}:`,
        err,
      );
      await recordFailedModelDiscoveryRun(sql, {
        hiveId: candidate.hive_id,
        adapterType: candidate.adapter_type,
        provider,
        credentialId: candidate.credential_id,
        source,
        error: errorMessage(err),
      });
    } finally {
      await releaseLock().catch((err) => {
        logger.error(
          `[dispatcher] Failed to release model discovery lock for hive ${candidate.hive_id} adapter ${candidate.adapter_type}:`,
          err,
        );
      });
    }
  }

  if (result.attempted > 0) {
    logger.log(
      `[dispatcher] Model discovery: attempted=${result.attempted} succeeded=${result.succeeded} failed=${result.failed} candidates=${result.candidates}`,
    );
  }

  return result;
}

async function findModelDiscoveryCandidates(sql: Sql): Promise<ModelDiscoveryCandidateRow[]> {
  return sql<ModelDiscoveryCandidateRow[]>`
    WITH configured AS (
      SELECT h.id AS hive_id,
             ac.adapter_type,
             NULL::uuid AS credential_id
      FROM hives h
      INNER JOIN adapter_config ac
        ON ac.hive_id = h.id OR ac.hive_id IS NULL
      WHERE ac.adapter_type = ANY(${SUPPORTED_DISCOVERY_ADAPTERS}::text[])

      UNION ALL

      SELECT hm.hive_id,
             hm.adapter_type,
             hm.credential_id
      FROM hive_models hm
      WHERE hm.enabled = true
        AND hm.adapter_type = ANY(${SUPPORTED_DISCOVERY_ADAPTERS}::text[])
    ),
    deduped AS (
      SELECT hive_id,
             adapter_type,
             (
               ARRAY_AGG(credential_id ORDER BY credential_id::text)
               FILTER (WHERE credential_id IS NOT NULL)
             )[1] AS credential_id
      FROM configured
      GROUP BY hive_id, adapter_type
    )
    SELECT d.hive_id,
           d.adapter_type,
           d.credential_id,
           last_run.started_at AS last_started_at
    FROM deduped d
    LEFT JOIN LATERAL (
      SELECT started_at
      FROM model_discovery_runs mdr
      WHERE mdr.hive_id = d.hive_id
        AND mdr.adapter_type = d.adapter_type
      ORDER BY started_at DESC
      LIMIT 1
    ) last_run ON true
    ORDER BY d.hive_id, d.adapter_type
  `;
}

async function loadLastModelDiscoveryStartedAt(
  sql: Sql,
  candidate: Pick<ModelDiscoveryCandidateRow, "hive_id" | "adapter_type">,
): Promise<Date | null> {
  const [row] = await sql<{ started_at: Date }[]>`
    SELECT started_at
    FROM model_discovery_runs
    WHERE hive_id = ${candidate.hive_id}
      AND adapter_type = ${candidate.adapter_type}
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return row?.started_at ?? null;
}

async function acquireModelDiscoveryLock(
  sql: Sql,
  lockKey: string,
): Promise<(() => Promise<void>) | null> {
  const lockSql = await sql.reserve();
  try {
    const [row] = await lockSql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        hashtext('hivewright:model-discovery'),
        hashtext(${lockKey})
      ) AS acquired
    `;
    if (row?.acquired !== true) {
      lockSql.release();
      return null;
    }

    return async () => {
      try {
        await lockSql`
          SELECT pg_advisory_unlock(
            hashtext('hivewright:model-discovery'),
            hashtext(${lockKey})
          )
        `;
      } finally {
        lockSql.release();
      }
    };
  } catch (err) {
    lockSql.release();
    throw err;
  }
}

function modelDiscoveryLockKey(
  candidate: Pick<ModelDiscoveryCandidateRow, "hive_id" | "adapter_type">,
): string {
  return `${candidate.hive_id}:${candidate.adapter_type}`;
}

async function loadDiscoveryCredentials(
  sql: Sql,
  input: {
    hiveId: string;
    adapterType: string;
    credentialId: string | null;
  },
): Promise<Record<string, string> | undefined> {
  if (!input.credentialId) return undefined;

  const [credential] = await sql<CredentialRow[]>`
    SELECT id, hive_id, key, value
    FROM credentials
    WHERE id = ${input.credentialId}
    LIMIT 1
  `;
  if (!credential) throw new Error("discovery credential not found");
  if (credential.hive_id && credential.hive_id !== input.hiveId) {
    throw new Error("discovery credential must be global or belong to the candidate hive");
  }

  const allowedKeys = expectedCredentialKeysForAdapter(input.adapterType);
  if (!allowedKeys.includes(credential.key)) {
    throw new Error(
      `discovery credential key must be one of ${allowedKeys.join(", ")} for ${input.adapterType}`,
    );
  }

  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  if (!encryptionKey) throw new Error("ENCRYPTION_KEY not configured for discovery credential");

  return { [credential.key]: decrypt(credential.value, encryptionKey) };
}

async function recordFailedModelDiscoveryRun(
  sql: Sql,
  input: {
    hiveId: string;
    adapterType: string;
    provider: string;
    credentialId: string | null;
    source: string;
    error: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO model_discovery_runs (
      hive_id,
      adapter_type,
      provider,
      credential_id,
      source,
      status,
      error,
      completed_at
    )
    VALUES (
      ${input.hiveId},
      ${input.adapterType},
      ${input.provider},
      ${input.credentialId},
      ${input.source},
      'failed',
      ${input.error.slice(0, 4000)},
      NOW()
    )
  `;
}

function discoveryIntervalMs(adapterType: string): number {
  return adapterType === "ollama" ? OLLAMA_DISCOVERY_INTERVAL_MS : CLOUD_DISCOVERY_INTERVAL_MS;
}

function providerForAdapter(adapterType: string): string {
  if (adapterType === "codex") return "openai";
  if (adapterType === "gemini") return "google";
  if (adapterType === "claude-code") return "anthropic";
  if (adapterType === "ollama") return "local";
  return "unknown";
}

function expectedCredentialKeysForAdapter(adapterType: string): string[] {
  if (adapterType === "codex") return ["OPENAI_API_KEY"];
  if (adapterType === "gemini") return ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  if (adapterType === "claude-code") return ["ANTHROPIC_API_KEY"];
  if (adapterType === "ollama") return ["OLLAMA_ENDPOINT", "OLLAMA_BASE_URL"];
  return [];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
