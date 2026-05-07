import { createHash } from "crypto";
import type { Sql } from "postgres";
import type { AdapterProbe, AdapterProbeCredential, ProbeResult } from "@/adapters/types";
import { decrypt } from "@/credentials/encryption";
import {
  canonicalModelIdForAdapter,
  configuredModelIdentityKey,
} from "@/model-health/model-identity";
import {
  DEFAULT_MODEL_HEALTH_MAX_AGE_MS,
  hasFreshHealthyModelHealth,
} from "@/model-health/freshness";
import {
  applyProbeJitter,
  getModelHealthProbePolicy,
} from "@/model-health/probe-policy";
import { loadModelHealthByIdentity } from "@/model-health/stored-health";

const DEFAULT_HEALTHY_TTL_MS = 60 * 60 * 1000;
const DEFAULT_UNHEALTHY_RETRY_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const NON_RETRYABLE_QUARANTINE_THRESHOLD = 2;

export interface RuntimeCredentialFingerprintInput {
  provider: string;
  adapterType: string;
  baseUrl?: string | null;
}

export interface ModelProbeRunnerInput {
  hiveId?: string | null;
  encryptionKey?: string;
  now?: Date;
  limit?: number;
  healthyTtlMs?: number;
  unhealthyRetryMs?: number;
  includeFresh?: boolean;
  includeOnDemand?: boolean;
  adapterFactory?: ModelProbeAdapterFactory;
  rows?: HiveModelProbeRow[];
}

export interface ModelProbeRunnerResult {
  considered: number;
  probed: number;
  healthy: number;
  unhealthy: number;
  skippedFresh: number;
  skippedDisabled: number;
  skippedCredentialErrors: number;
  errors: Array<{
    modelId: string;
    adapterType: string;
    reason: string;
  }>;
}

export type ModelProbeAdapterFactory = (adapterType: string, sql: Sql) => Promise<AdapterProbe>;

export interface HiveModelProbeRow {
  hive_id: string;
  provider: string;
  model_id: string;
  health_model_id: string;
  adapter_type: string;
  credential_id: string | null;
  credential_key: string | null;
  credential_value: string | null;
  credential_fingerprint: string | null;
  capabilities: string[];
  sample_cost_usd?: string | number | null;
  next_probe_at?: Date | null;
}

export interface DueModelHealthProbeRoute {
  provider: string;
  adapterType: string;
  modelId: string;
  healthModelId: string;
  fingerprint: string;
  credentialId: string | null;
  credentialKey: string | null;
  credentialValue: string | null;
  capabilities: string[];
  nextProbeAt: Date | null;
  sampleCostUsd: number | null;
  sharedAcrossHives: number;
}

interface RawHiveModelProbeRow {
  hive_id: string;
  provider: string;
  model_id: string;
  adapter_type: string;
  credential_id: string | null;
  credential_key: string | null;
  credential_value: string | null;
  credential_fingerprint: string | null;
  capabilities: string[];
}

export function createRuntimeCredentialFingerprint(input: RuntimeCredentialFingerprintInput): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "runtime",
      input.provider.trim().toLowerCase(),
      input.adapterType.trim().toLowerCase(),
      normalizeBaseUrl(input.baseUrl),
    ]))
    .digest("hex");
}

export async function runModelHealthProbes(
  sql: Sql,
  input: ModelProbeRunnerInput = {},
): Promise<ModelProbeRunnerResult> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const healthyTtlMs = input.healthyTtlMs ?? DEFAULT_HEALTHY_TTL_MS;
  const unhealthyRetryMs = input.unhealthyRetryMs ?? DEFAULT_UNHEALTHY_RETRY_MS;
  const adapterFactory = input.adapterFactory ?? defaultAdapterFactory;
  const rows = input.rows ?? await loadEnabledHiveModels(sql, {
    hiveId: input.hiveId ?? null,
    limit,
    includeOnDemand: input.includeOnDemand ?? true,
  });
  const result: ModelProbeRunnerResult = {
    considered: rows.length,
    probed: 0,
    healthy: 0,
    unhealthy: 0,
    skippedFresh: 0,
    skippedDisabled: 0,
    skippedCredentialErrors: 0,
    errors: [],
  };

  for (const row of rows) {
    const credential = buildProbeCredential(row, {
      encryptionKey: input.encryptionKey ?? process.env.ENCRYPTION_KEY ?? "",
    });

    if (!credential.ok) {
      result.skippedCredentialErrors += 1;
      result.errors.push({
        modelId: row.model_id,
        adapterType: row.adapter_type,
        reason: credential.reason,
      });
      await upsertCredentialError(sql, {
        fingerprint: credential.fingerprint,
        modelId: row.health_model_id,
        now,
        reason: credential.reason,
        retryAt: new Date(now.getTime() + unhealthyRetryMs),
      });
      continue;
    }

    if (!input.includeFresh) {
      const fresh = await hasFreshHealth(sql, {
        fingerprint: credential.value.fingerprint!,
        provider: row.provider,
        modelId: row.health_model_id,
        adapterType: row.adapter_type,
        rawModelId: row.model_id,
        capabilities: row.capabilities ?? [],
        now,
      });
      if (fresh) {
        result.skippedFresh += 1;
        continue;
      }
    }

    const adapter = await adapterFactory(row.adapter_type, sql);
    const probeResult = await adapter.probe(row.model_id, credential.value);
    const policy = getModelHealthProbePolicy({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.health_model_id,
      capabilities: row.capabilities ?? [],
      sampleCostUsd: probeResult.costEstimateUsd ?? asNullableNumber(row.sample_cost_usd),
    });
    const nextProbeDelayMs = probeResult.healthy
      ? (input.healthyTtlMs ?? policy.healthyTtlMs ?? healthyTtlMs)
      : (input.unhealthyRetryMs ?? policy.unhealthyRetryMs ?? unhealthyRetryMs);
    const nextProbeAt = new Date(
      now.getTime() + applyProbeJitter(nextProbeDelayMs, policy.jitterRatio, [
        credential.value.fingerprint!,
        row.health_model_id,
      ].join(":")),
    );

    await upsertProbeResult(sql, {
      fingerprint: credential.value.fingerprint!,
      modelId: row.health_model_id,
      probeResult,
      now,
      nextProbeAt,
    });

    result.probed += 1;
    if (probeResult.healthy) {
      result.healthy += 1;
    } else {
      result.unhealthy += 1;
    }
  }

  return result;
}

export async function selectDueModelHealthProbeRoutes(
  sql: Sql,
  input: {
    now?: Date;
    limit?: number;
    hiveId?: string | null;
    includeOnDemand?: boolean;
  } = {},
): Promise<DueModelHealthProbeRoute[]> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const rows = await loadEnabledHiveModels(sql, {
    hiveId: input.hiveId ?? null,
    limit: Math.max(limit * 4, limit),
    includeOnDemand: true,
  });
  const due: DueModelHealthProbeRoute[] = [];

  for (const row of rows) {
    const fingerprint = row.credential_fingerprint ?? createRuntimeCredentialFingerprint({
      provider: row.provider,
      adapterType: row.adapter_type,
      baseUrl: null,
    });
    const health = await loadModelHealthByIdentity(sql, {
      fingerprint,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    });
    if (health?.status === "quarantined") {
      continue;
    }
    const policy = getModelHealthProbePolicy({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.health_model_id,
      capabilities: row.capabilities ?? [],
      sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
    });
    if (policy.mode === "on_demand" && !(input.includeOnDemand ?? false)) {
      continue;
    }
    const nextProbeAt = health?.next_probe_at ?? null;
    if (hasFreshHealthyModelHealth({
      status: health?.status,
      lastProbedAt: health?.last_probed_at,
      nextProbeAt,
      now,
      maxAgeMs: policy.healthyTtlMs ?? DEFAULT_MODEL_HEALTH_MAX_AGE_MS,
    })) {
      continue;
    }
    due.push({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.model_id,
      healthModelId: row.health_model_id,
      fingerprint,
      credentialId: row.credential_id,
      credentialKey: row.credential_key,
      credentialValue: row.credential_value,
      capabilities: row.capabilities ?? [],
      nextProbeAt,
      sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
      sharedAcrossHives: 1,
    });
  }

  return due
    .sort((a, b) => {
      const aTime = a.nextProbeAt?.getTime() ?? 0;
      const bTime = b.nextProbeAt?.getTime() ?? 0;
      return aTime - bTime;
    })
    .slice(0, limit);
}

async function loadEnabledHiveModels(
  sql: Sql,
  input: { hiveId: string | null; limit: number; includeOnDemand: boolean },
): Promise<HiveModelProbeRow[]> {
  const rows = await sql<RawHiveModelProbeRow[]>`
    SELECT
      hm.hive_id,
      hm.provider,
      hm.model_id,
      hm.adapter_type,
      hm.credential_id,
      hm.capabilities,
      c.key AS credential_key,
      c.value AS credential_value,
      c.fingerprint AS credential_fingerprint
    FROM hive_models hm
    LEFT JOIN credentials c ON c.id = hm.credential_id
    WHERE hm.enabled = true
      ${input.hiveId ? sql`AND hm.hive_id = ${input.hiveId}` : sql``}
    ORDER BY hm.fallback_priority ASC, hm.created_at ASC
  `;
  const deduped = dedupeProbeRows(rows);
  const filtered = input.includeOnDemand
    ? deduped
    : deduped.filter((row) => {
        const policy = getModelHealthProbePolicy({
          provider: row.provider,
          adapterType: row.adapter_type,
          modelId: row.health_model_id,
          capabilities: row.capabilities ?? [],
          sampleCostUsd: asNullableNumber(row.sample_cost_usd),
        });
        return policy.mode === "automatic";
      });
  return filtered.slice(0, input.limit);
}

function buildProbeCredential(
  row: HiveModelProbeRow,
  input: { encryptionKey: string },
): { ok: true; value: AdapterProbeCredential } | { ok: false; fingerprint: string; reason: string } {
  if (!row.credential_id) {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: row.provider,
      adapterType: row.adapter_type,
      baseUrl: null,
    });
    return {
      ok: true,
      value: {
        provider: row.provider,
        baseUrl: null,
        fingerprint,
        secrets: {},
      },
    };
  }

  const fallbackFingerprint = row.credential_fingerprint ?? createRuntimeCredentialFingerprint({
    provider: row.provider,
    adapterType: row.adapter_type,
    baseUrl: null,
  });
  if (!row.credential_key || !row.credential_value) {
    return {
      ok: false,
      fingerprint: fallbackFingerprint,
      reason: "credential row is missing key or value",
    };
  }
  if (!input.encryptionKey) {
    return {
      ok: false,
      fingerprint: fallbackFingerprint,
      reason: "ENCRYPTION_KEY is not configured for model health credential decrypt",
    };
  }

  try {
    const secret = decrypt(row.credential_value, input.encryptionKey);
    return {
      ok: true,
      value: {
        provider: row.provider,
        baseUrl: null,
        fingerprint: fallbackFingerprint,
        secrets: { [row.credential_key]: secret },
      },
    };
  } catch {
    return {
      ok: false,
      fingerprint: fallbackFingerprint,
      reason: "credential decrypt failed for model health probe",
    };
  }
}

async function hasFreshHealth(
  sql: Sql,
  input: {
    fingerprint: string;
    provider: string;
    adapterType: string;
    modelId: string;
    rawModelId?: string;
    capabilities: string[];
    now: Date;
  },
): Promise<boolean> {
  const health = await loadModelHealthByIdentity(sql, {
    fingerprint: input.fingerprint,
    adapterType: input.adapterType,
    modelId: input.rawModelId ?? input.modelId,
  });
  const policy = getModelHealthProbePolicy({
    provider: input.provider,
    adapterType: input.adapterType,
    modelId: input.modelId,
    capabilities: input.capabilities,
    sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
  });
  return hasFreshHealthyModelHealth({
    status: health?.status,
    lastProbedAt: health?.last_probed_at,
    nextProbeAt: health?.next_probe_at,
    now: input.now,
    maxAgeMs: policy.healthyTtlMs ?? DEFAULT_MODEL_HEALTH_MAX_AGE_MS,
  });
}

async function upsertProbeResult(
  sql: Sql,
  input: {
    fingerprint: string;
    modelId: string;
    probeResult: ProbeResult;
    now: Date;
    nextProbeAt: Date;
  },
): Promise<void> {
  const previous = await loadModelHealthByIdentity(sql, {
    fingerprint: input.fingerprint,
    adapterType: "",
    modelId: input.modelId,
  });
  const previousFailure = parseFailurePayload(previous?.last_failure_reason ?? null);
  const consecutiveNonRetryableFailures = input.probeResult.healthy
    ? 0
    : input.probeResult.reason.retryable
      ? 0
      : previousFailure.consecutiveNonRetryableFailures + 1;
  const quarantined = !input.probeResult.healthy &&
    !input.probeResult.reason.retryable &&
    consecutiveNonRetryableFailures >= NON_RETRYABLE_QUARANTINE_THRESHOLD;
  const failureReason = input.probeResult.healthy
    ? null
    : JSON.stringify({
        ...input.probeResult.reason,
        consecutiveNonRetryableFailures,
        quarantine: {
          active: quarantined,
          reason: quarantined ? input.probeResult.reason.code : null,
          threshold: NON_RETRYABLE_QUARANTINE_THRESHOLD,
        },
      });
  const lastFailedAt = input.probeResult.healthy ? null : input.now;
  const persistedStatus = quarantined ? "quarantined" : input.probeResult.status;
  const persistedNextProbeAt = quarantined ? null : input.nextProbeAt;

  await sql`
    INSERT INTO model_health (
      fingerprint,
      model_id,
      status,
      last_probed_at,
      last_failed_at,
      last_failure_reason,
      next_probe_at,
      latency_ms,
      sample_cost_usd,
      updated_at
    )
    VALUES (
      ${input.fingerprint},
      ${input.modelId},
      ${persistedStatus},
      ${input.now},
      ${lastFailedAt},
      ${failureReason},
      ${persistedNextProbeAt},
      ${input.probeResult.latencyMs},
      ${input.probeResult.costEstimateUsd.toFixed(6)},
      NOW()
    )
    ON CONFLICT (fingerprint, model_id) DO UPDATE
      SET status = EXCLUDED.status,
          last_probed_at = EXCLUDED.last_probed_at,
          last_failed_at = EXCLUDED.last_failed_at,
          last_failure_reason = EXCLUDED.last_failure_reason,
          next_probe_at = EXCLUDED.next_probe_at,
          latency_ms = EXCLUDED.latency_ms,
          sample_cost_usd = EXCLUDED.sample_cost_usd,
          updated_at = NOW()
  `;
}

async function upsertCredentialError(
  sql: Sql,
  input: {
    fingerprint: string;
    modelId: string;
    now: Date;
    reason: string;
    retryAt: Date;
  },
): Promise<void> {
  await sql`
    INSERT INTO model_health (
      fingerprint,
      model_id,
      status,
      last_probed_at,
      last_failed_at,
      last_failure_reason,
      next_probe_at,
      updated_at
    )
    VALUES (
      ${input.fingerprint},
      ${input.modelId},
      'unhealthy',
      ${input.now},
      ${input.now},
      ${JSON.stringify({
        code: "credential_unavailable",
        message: input.reason,
        failureClass: "auth",
        retryable: true,
      })},
      ${input.retryAt},
      NOW()
    )
    ON CONFLICT (fingerprint, model_id) DO UPDATE
      SET status = EXCLUDED.status,
          last_probed_at = EXCLUDED.last_probed_at,
          last_failed_at = EXCLUDED.last_failed_at,
          last_failure_reason = EXCLUDED.last_failure_reason,
          next_probe_at = EXCLUDED.next_probe_at,
          updated_at = NOW()
  `;
}

export async function defaultAdapterFactory(adapterType: string, sql: Sql): Promise<AdapterProbe> {
  switch (adapterType) {
    case "openclaw": {
      const { OpenClawAdapter } = await import("@/adapters/openclaw");
      return new OpenClawAdapter();
    }
    case "ollama": {
      const { OllamaAdapter } = await import("@/adapters/ollama");
      return new OllamaAdapter();
    }
    case "claude-code": {
      const { ClaudeCodeAdapter } = await import("@/adapters/claude-code");
      return new ClaudeCodeAdapter();
    }
    case "codex": {
      const { CodexAdapter } = await import("@/adapters/codex");
      return new CodexAdapter(sql);
    }
    case "gemini": {
      const { GeminiAdapter } = await import("@/adapters/gemini");
      return new GeminiAdapter();
    }
    case "openai-image": {
      const { OpenAIImageAdapter } = await import("@/adapters/openai-image");
      return new OpenAIImageAdapter();
    }
    default: {
      const { ClaudeCodeAdapter } = await import("@/adapters/claude-code");
      return new ClaudeCodeAdapter();
    }
  }
}

function parseFailurePayload(value: string | null): { consecutiveNonRetryableFailures: number } {
  if (!value) return { consecutiveNonRetryableFailures: 0 };
  try {
    const parsed = JSON.parse(value) as { consecutiveNonRetryableFailures?: unknown };
    return {
      consecutiveNonRetryableFailures: typeof parsed.consecutiveNonRetryableFailures === "number"
        ? parsed.consecutiveNonRetryableFailures
        : 0,
    };
  } catch {
    return { consecutiveNonRetryableFailures: 0 };
  }
}

function dedupeProbeRows(rows: RawHiveModelProbeRow[]): HiveModelProbeRow[] {
  const grouped = new Map<string, RawHiveModelProbeRow[]>();
  for (const row of rows) {
    const fingerprint = row.credential_fingerprint ?? createRuntimeCredentialFingerprint({
      provider: row.provider,
      adapterType: row.adapter_type,
      baseUrl: null,
    });
    const key = `${configuredModelIdentityKey({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    })}:${fingerprint}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return [...grouped.values()].map((group) => {
    const canonicalModelId = canonicalModelIdForAdapter(group[0].adapter_type, group[0].model_id);
    const selected = [...group].sort((a, b) => {
      const aCanonical = a.model_id === canonicalModelId;
      const bCanonical = b.model_id === canonicalModelId;
      if (aCanonical !== bCanonical) return aCanonical ? -1 : 1;
      return a.model_id.localeCompare(b.model_id);
    })[0];
    return {
      ...selected,
      health_model_id: canonicalModelId,
    };
  });
}

function asNullableNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBaseUrl(baseUrl: string | null | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}
