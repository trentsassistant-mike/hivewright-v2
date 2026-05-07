import type { Sql } from "postgres";
import {
  DEFAULT_MODEL_HEALTH_MAX_AGE_MS,
  hasFreshHealthyModelHealth,
} from "./freshness";
import { createRuntimeCredentialFingerprint } from "./probe-runner";
import { loadModelHealthByIdentity } from "./stored-health";

export type ModelSpawnHealthReason =
  | "fresh_healthy_probe"
  | "model_registry_missing"
  | "model_registry_disabled"
  | "credential_fingerprint_missing"
  | "health_probe_missing"
  | "health_probe_quarantined"
  | "health_probe_stale"
  | "health_probe_unhealthy";

export interface ModelSpawnHealthInput {
  hiveId: string;
  adapterType: string;
  modelId: string;
  now?: Date;
  maxHealthAgeMs?: number;
}

export interface ModelSpawnHealthDecision {
  canRun: boolean;
  reason: ModelSpawnHealthReason;
  status?: string | null;
  fingerprint?: string;
  lastProbedAt?: Date | null;
  nextProbeAt?: Date | null;
  failureReason?: string | null;
}

interface HiveModelRow {
  provider: string;
  model_id: string;
  adapter_type: string;
  credential_id: string | null;
  credential_fingerprint: string | null;
  enabled: boolean;
}

export async function checkModelSpawnHealth(
  sql: Sql,
  input: ModelSpawnHealthInput,
): Promise<ModelSpawnHealthDecision> {
  const now = input.now ?? new Date();
  const maxHealthAgeMs = input.maxHealthAgeMs ?? DEFAULT_MODEL_HEALTH_MAX_AGE_MS;
  const adapterType = input.adapterType.trim();
  const modelId = input.modelId.trim();

  const [model] = await sql<HiveModelRow[]>`
    SELECT
      hm.provider,
      hm.model_id,
      hm.adapter_type,
      hm.credential_id,
      hm.enabled,
      c.fingerprint AS credential_fingerprint
    FROM hive_models hm
    LEFT JOIN credentials c ON c.id = hm.credential_id
    WHERE hm.hive_id = ${input.hiveId}
      AND hm.adapter_type = ${adapterType}
      AND hm.model_id = ${modelId}
    ORDER BY hm.enabled DESC, hm.fallback_priority ASC, hm.created_at ASC
    LIMIT 1
  `;

  if (!model) {
    return { canRun: false, reason: "model_registry_missing" };
  }
  if (!model.enabled) {
    return { canRun: false, reason: "model_registry_disabled" };
  }

  const fingerprint = model.credential_id
    ? model.credential_fingerprint
    : createRuntimeCredentialFingerprint({
        provider: model.provider,
        adapterType: model.adapter_type,
        baseUrl: null,
      });

  if (!fingerprint) {
    return { canRun: false, reason: "credential_fingerprint_missing" };
  }

  const health = await loadModelHealthByIdentity(sql, {
    fingerprint,
    adapterType,
    modelId,
  });

  if (!health) {
    return { canRun: false, reason: "health_probe_missing", fingerprint };
  }

  const baseDecision = {
    fingerprint,
    status: health.status,
    lastProbedAt: health.last_probed_at,
    nextProbeAt: health.next_probe_at,
    failureReason: health.last_failure_reason,
  };

  if (health.status === "quarantined") {
    return { ...baseDecision, canRun: false, reason: "health_probe_quarantined" };
  }

  if (health.status !== "healthy") {
    return { ...baseDecision, canRun: false, reason: "health_probe_unhealthy" };
  }

  if (!hasFreshHealthyModelHealth({
    status: health.status,
    lastProbedAt: health.last_probed_at,
    nextProbeAt: health.next_probe_at,
    now,
    maxAgeMs: maxHealthAgeMs,
  })) {
    return { ...baseDecision, canRun: false, reason: "health_probe_stale" };
  }

  return { ...baseDecision, canRun: true, reason: "fresh_healthy_probe" };
}
