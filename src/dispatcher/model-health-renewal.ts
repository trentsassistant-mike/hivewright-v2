import type { Sql } from "postgres";
import {
  defaultAdapterFactory,
  runModelHealthProbes,
  selectDueModelHealthProbeRoutes,
  type ModelProbeAdapterFactory,
  type DueModelHealthProbeRoute,
} from "@/model-health/probe-runner";

const DEFAULT_MAX_ROUTES_PER_TICK = 5;

export interface SystemModelHealthRenewalResult {
  candidates: number;
  attempted: number;
  probed: number;
  healthy: number;
  unhealthy: number;
  skippedLocked: number;
}

interface PausedHiveRow {
  hive_id: string;
}

export async function runSystemModelHealthRenewal(
  sql: Sql,
  input: {
    now?: Date;
    encryptionKey?: string;
    maxRoutesPerTick?: number;
    adapterFactory?: ModelProbeAdapterFactory;
    logger?: Pick<Console, "log" | "error">;
  } = {},
): Promise<SystemModelHealthRenewalResult> {
  const now = input.now ?? new Date();
  const maxRoutesPerTick = input.maxRoutesPerTick ?? DEFAULT_MAX_ROUTES_PER_TICK;
  const logger = input.logger ?? console;
  const candidates = await selectRenewalCandidates(sql, {
    now,
    limit: maxRoutesPerTick,
  });

  let attempted = 0;
  let probed = 0;
  let healthy = 0;
  let unhealthy = 0;
  let skippedLocked = 0;

  for (const candidate of candidates) {
    const lockKey = `${candidate.fingerprint}:${candidate.healthModelId}`;
    const releaseLock = await acquireRenewalLock(sql, lockKey);
    if (!releaseLock) {
      skippedLocked += 1;
      continue;
    }

    try {
      attempted += 1;
      const result = await runModelHealthProbes(sql, {
        now,
        encryptionKey: input.encryptionKey,
        limit: 1,
        includeFresh: false,
        includeOnDemand: false,
        adapterFactory: input.adapterFactory ?? defaultAdapterFactory,
        rows: [{
          hive_id: "",
          provider: candidate.provider,
          model_id: candidate.modelId,
          health_model_id: candidate.healthModelId,
          adapter_type: candidate.adapterType,
          credential_id: candidate.credentialId,
          credential_key: candidate.credentialKey,
          credential_value: candidate.credentialValue,
          credential_fingerprint: candidate.fingerprint,
          capabilities: candidate.capabilities,
          sample_cost_usd: candidate.sampleCostUsd,
          next_probe_at: candidate.nextProbeAt,
        }],
      });
      probed += result.probed;
      healthy += result.healthy;
      unhealthy += result.unhealthy;
    } catch (err) {
      logger.error("[dispatcher] model-health renewal failed:", err);
    } finally {
      await releaseLock();
    }
  }

  if (attempted > 0) {
    logger.log(
      `[dispatcher] model-health renewal attempted=${attempted} probed=${probed} healthy=${healthy} unhealthy=${unhealthy} candidates=${candidates.length} locked=${skippedLocked}`,
    );
  }

  return {
    candidates: candidates.length,
    attempted,
    probed,
    healthy,
    unhealthy,
    skippedLocked,
  };
}

async function selectRenewalCandidates(
  sql: Sql,
  input: { now: Date; limit: number },
): Promise<DueModelHealthProbeRoute[]> {
  const prioritized: DueModelHealthProbeRoute[] = [];
  const seen = new Set<string>();

  const pausedHives = await sql<PausedHiveRow[]>`
    SELECT hive_id
    FROM hive_runtime_locks
    WHERE creation_paused = true
    ORDER BY updated_at DESC NULLS LAST, hive_id ASC
  `;

  for (const hive of pausedHives) {
    if (prioritized.length >= input.limit) break;
    const hiveCandidates = await selectDueModelHealthProbeRoutes(sql, {
      now: input.now,
      limit: input.limit - prioritized.length,
      hiveId: hive.hive_id,
      includeOnDemand: false,
    });
    for (const candidate of hiveCandidates) {
      const key = renewalCandidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      prioritized.push(candidate);
      if (prioritized.length >= input.limit) break;
    }
  }

  if (prioritized.length >= input.limit) {
    return prioritized;
  }

  const globalCandidates = await selectDueModelHealthProbeRoutes(sql, {
    now: input.now,
    limit: input.limit,
    includeOnDemand: false,
  });

  for (const candidate of globalCandidates) {
    const key = renewalCandidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    prioritized.push(candidate);
    if (prioritized.length >= input.limit) break;
  }

  return prioritized;
}

function renewalCandidateKey(candidate: DueModelHealthProbeRoute): string {
  return `${candidate.fingerprint}:${candidate.healthModelId}`;
}

async function acquireRenewalLock(
  sql: Sql,
  lockKey: string,
): Promise<(() => Promise<void>) | null> {
  const lockSql = await sql.reserve();
  try {
    const [row] = await lockSql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        hashtext('hivewright:model-health-renewal'),
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
            hashtext('hivewright:model-health-renewal'),
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
