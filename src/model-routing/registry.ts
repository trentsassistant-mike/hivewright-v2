import type { Sql } from "postgres";
import type {
  ModelCapabilityAxis,
  ModelCapabilityConfidence,
  ModelCapabilityScoreView,
} from "@/model-catalog/capability-scores";
import {
  canonicalModelIdForAdapter,
  collapseConfiguredModelAliasRows,
} from "@/model-health/model-identity";
import { classifyProbeFreshness, getModelHealthProbePolicy } from "@/model-health/probe-policy";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { loadModelHealthByIdentity } from "@/model-health/stored-health";
import {
  loadModelRoutingPolicyState,
  type ModelRoutingPolicyState,
} from "./policy";
import { MODEL_ROUTING_PROFILES } from "./profiles";
import type { ModelRoutingPolicy } from "./selector";

type RegistryHealthStatus = "healthy" | "unknown" | "unhealthy";

interface HiveModelRegistryRow {
  id: string;
  provider: string;
  model_id: string;
  adapter_type: string;
  credential_id: string | null;
  credential_name: string | null;
  credential_fingerprint: string | null;
  capabilities: string[];
  fallback_priority: number;
  enabled: boolean;
  cost_per_input_token: string | null;
  cost_per_output_token: string | null;
  benchmark_quality_score: string | number | null;
  routing_cost_score: string | number | null;
}

type CapabilityScoreRow = {
  model_catalog_id: string | null;
  provider: string;
  adapter_type: string;
  model_id: string;
  canonical_model_id: string;
  axis: ModelCapabilityAxis;
  score: string | number;
  raw_score: string | null;
  source: string;
  source_url: string;
  benchmark_name: string;
  model_version_matched: string;
  confidence: ModelCapabilityConfidence;
  updated_at: Date | null;
};

export interface ModelRoutingRegistryRow {
  id: string;
  routeKey: string;
  provider: string;
  adapterType: string;
  model: string;
  credentialId: string | null;
  credentialName: string | null;
  credentialFingerprint: string | null;
  healthFingerprint: string;
  capabilities: string[];
  fallbackPriority: number;
  hiveModelEnabled: boolean;
  routingEnabled: boolean;
  roleSlugs: string[];
  status: RegistryHealthStatus;
  qualityScore: number | null;
  costScore: number | null;
  capabilityScores: ModelCapabilityScoreView[];
  costPerInputToken: string | null;
  costPerOutputToken: string | null;
  local: boolean;
  lastProbedAt: Date | null;
  lastFailedAt: Date | null;
  lastFailureReason: string | null;
  failureClass: string | null;
  failureMessage: string | null;
  nextProbeAt: Date | null;
  probeFreshness: "unknown" | "fresh" | "due";
  probeMode: "automatic" | "on_demand";
  latencyMs: number | null;
  sampleCostUsd: number | null;
}

export interface ModelRoutingView {
  models: ModelRoutingRegistryRow[];
  policy: ModelRoutingPolicy;
  basePolicyState: ModelRoutingPolicyState;
  profiles: typeof MODEL_ROUTING_PROFILES;
}

export function routeKeyForModel(input: {
  provider: string;
  adapterType: string;
  model: string;
}): string {
  return `${input.provider}:${input.adapterType}:${input.model}`;
}

export async function loadModelRoutingView(
  sql: Sql,
  hiveId: string,
): Promise<ModelRoutingView> {
  const basePolicyState = await loadModelRoutingPolicyState(sql, hiveId);
  const basePolicy = basePolicyState.policy;
  const modelRows = await sql<HiveModelRegistryRow[]>`
    SELECT
      hm.id,
      hm.provider,
      hm.model_id,
      hm.adapter_type,
      hm.credential_id,
      c.name AS credential_name,
      c.fingerprint AS credential_fingerprint,
      hm.capabilities,
      hm.fallback_priority,
      hm.enabled,
      hm.cost_per_input_token,
      hm.cost_per_output_token,
      hm.benchmark_quality_score,
      hm.routing_cost_score
    FROM hive_models hm
    LEFT JOIN credentials c ON c.id = hm.credential_id
    WHERE hm.hive_id = ${hiveId}
    ORDER BY hm.fallback_priority ASC, hm.created_at ASC
  `;

  const collapsedRows = collapseConfiguredModelAliasRows(modelRows);
  const capabilityScoresByModel = await loadCapabilityScoresByModel(sql, collapsedRows);

  const models: ModelRoutingRegistryRow[] = [];
  for (const row of collapsedRows) {
    const healthFingerprint = row.credential_fingerprint ?? createRuntimeCredentialFingerprint({
      provider: row.provider,
      adapterType: row.adapter_type,
      baseUrl: null,
    });
    const health = await loadModelHealthByIdentity(sql, {
      fingerprint: healthFingerprint,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    });
    const routeKey = routeKeyForModel({
      provider: row.provider,
      adapterType: row.adapter_type,
      model: row.model_id,
    });
    const override = basePolicy?.routeOverrides?.[routeKey];
    const failure = parseFailureReason(health?.last_failure_reason ?? null);
    const probeMode = getModelHealthProbePolicy({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: canonicalModelIdForAdapter(row.adapter_type, row.model_id),
      capabilities: row.capabilities ?? [],
      sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
    }).mode;

    models.push({
      id: row.id,
      routeKey,
      provider: row.provider,
      adapterType: row.adapter_type,
      model: row.model_id,
      credentialId: row.credential_id,
      credentialName: row.credential_name,
      credentialFingerprint: row.credential_fingerprint,
      healthFingerprint,
      capabilities: row.capabilities ?? [],
      fallbackPriority: row.fallback_priority,
      hiveModelEnabled: row.enabled,
      routingEnabled: override?.enabled ?? row.enabled,
      roleSlugs: override?.roleSlugs ?? [],
      status: normalizeHealthStatus(health?.status),
      qualityScore: asNullableNumber(row.benchmark_quality_score),
      costScore: asNullableNumber(row.routing_cost_score),
      capabilityScores: capabilityScoresByModel.get(capabilityScoreKey(row)) ?? [],
      costPerInputToken: row.cost_per_input_token,
      costPerOutputToken: row.cost_per_output_token,
      local: isLocalModel(row.provider, row.adapter_type),
      lastProbedAt: health?.last_probed_at ?? null,
      lastFailedAt: health?.last_failed_at ?? null,
      lastFailureReason: health?.last_failure_reason ?? null,
      failureClass: failure.failureClass,
      failureMessage: failure.message,
      nextProbeAt: health?.next_probe_at ?? null,
      probeFreshness: classifyProbeFreshness(health?.next_probe_at ?? null, new Date()),
      probeMode,
      latencyMs: health?.latency_ms ?? null,
      sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
    });
  }

  return {
    models,
    policy: {
      preferences: basePolicy?.preferences,
      routeOverrides: basePolicy?.routeOverrides,
      roleRoutes: basePolicy?.roleRoutes,
      candidates: models.map((model) => ({
        adapterType: model.adapterType,
        model: model.model,
        enabled: model.hiveModelEnabled && model.routingEnabled,
        status: model.status,
        probeFreshness: model.probeFreshness === "unknown" ? undefined : model.probeFreshness,
        qualityScore: model.qualityScore ?? undefined,
        costScore: model.costScore ?? undefined,
        capabilityScores: model.capabilityScores,
        local: model.local,
        roleSlugs: model.roleSlugs.length > 0 ? model.roleSlugs : undefined,
      })),
    },
    basePolicyState,
    profiles: MODEL_ROUTING_PROFILES,
  };
}

async function loadCapabilityScoresByModel(
  sql: Sql,
  rows: HiveModelRegistryRow[],
): Promise<Map<string, ModelCapabilityScoreView[]>> {
  if (rows.length === 0) return new Map();

  const keys = [...new Map(rows.map((row) => {
    const key = capabilityScoreKey(row);
    return [key, {
      key,
      provider: row.provider,
      adapterType: row.adapter_type,
      canonicalModelId: canonicalModelIdForAdapter(row.adapter_type, row.model_id),
    }];
  })).values()];
  const keySet = new Set(keys.map((key) => key.key));
  const keyConditions = keys.map((key) => sql`
    (
      provider = ${key.provider}
      AND adapter_type = ${key.adapterType}
      AND canonical_model_id = ${key.canonicalModelId}
    )
  `);
  let keyFilter = keyConditions[0];
  for (const condition of keyConditions.slice(1)) {
    keyFilter = sql`${keyFilter} OR ${condition}`;
  }

  const scoreRows = await sql<CapabilityScoreRow[]>`
    SELECT
      model_catalog_id,
      provider,
      adapter_type,
      model_id,
      canonical_model_id,
      axis,
      score,
      raw_score,
      source,
      source_url,
      benchmark_name,
      model_version_matched,
      confidence,
      updated_at
    FROM model_capability_scores
    WHERE ${keyFilter}
    ORDER BY
      axis ASC,
      CASE confidence
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 1
        ELSE 0
      END DESC,
      updated_at DESC NULLS LAST,
      source ASC,
      benchmark_name ASC
  `;

  const bestScoresByModelAxis = new Map<string, ModelCapabilityScoreView>();
  for (const row of scoreRows) {
    const key = capabilityScoreKey({
      provider: row.provider,
      adapter_type: row.adapter_type,
      model_id: row.canonical_model_id,
    });
    if (!keySet.has(key)) continue;

    const score = capabilityScoreViewFromRow(row);
    const axisKey = `${key}:${score.axis}`;
    const current = bestScoresByModelAxis.get(axisKey);
    if (!current || compareCapabilityScores(score, current) > 0) {
      bestScoresByModelAxis.set(axisKey, score);
    }
  }

  const scoresByModel = new Map<string, ModelCapabilityScoreView[]>();
  for (const [axisKey, score] of bestScoresByModelAxis) {
    const modelKey = axisKey.slice(0, axisKey.lastIndexOf(":"));
    scoresByModel.set(modelKey, [...(scoresByModel.get(modelKey) ?? []), score]);
  }
  for (const [key, scores] of scoresByModel) {
    scoresByModel.set(key, scores.sort(compareCapabilityScoreViewsForOutput));
  }
  return scoresByModel;
}

function capabilityScoreViewFromRow(row: CapabilityScoreRow): ModelCapabilityScoreView {
  return {
    modelCatalogId: row.model_catalog_id,
    provider: row.provider,
    adapterType: row.adapter_type,
    modelId: row.model_id,
    canonicalModelId: row.canonical_model_id,
    axis: row.axis,
    score: asNullableNumber(row.score) ?? 0,
    rawScore: row.raw_score,
    source: row.source,
    sourceUrl: row.source_url,
    benchmarkName: row.benchmark_name,
    modelVersionMatched: row.model_version_matched,
    confidence: row.confidence,
    updatedAt: row.updated_at,
  };
}

function compareCapabilityScoreViewsForOutput(
  a: ModelCapabilityScoreView,
  b: ModelCapabilityScoreView,
): number {
  return a.axis.localeCompare(b.axis) ||
    a.source.localeCompare(b.source) ||
    a.benchmarkName.localeCompare(b.benchmarkName);
}

function compareCapabilityScores(
  a: ModelCapabilityScoreView,
  b: ModelCapabilityScoreView,
): number {
  return confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    Number(a.updatedAt?.getTime() ?? 0) - Number(b.updatedAt?.getTime() ?? 0) ||
    b.source.localeCompare(a.source) ||
    b.benchmarkName.localeCompare(a.benchmarkName);
}

function confidenceRank(confidence: ModelCapabilityConfidence): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function capabilityScoreKey(input: {
  provider: string;
  adapter_type: string;
  model_id: string;
}): string {
  return [
    input.provider.trim().toLowerCase(),
    input.adapter_type.trim().toLowerCase(),
    canonicalModelIdForAdapter(input.adapter_type, input.model_id).toLowerCase(),
  ].join(":");
}

function normalizeHealthStatus(value: string | null | undefined): RegistryHealthStatus {
  if (value === "healthy" || value === "unhealthy") return value;
  return "unknown";
}

function asNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isLocalModel(provider: string, adapterType: string): boolean {
  return provider.trim().toLowerCase() === "local" ||
    adapterType.trim().toLowerCase() === "ollama";
}

function parseFailureReason(value: string | null): {
  failureClass: string | null;
  message: string | null;
} {
  if (!value) return { failureClass: null, message: null };
  try {
    const parsed = JSON.parse(value) as { failureClass?: unknown; message?: unknown };
    return {
      failureClass: typeof parsed.failureClass === "string" ? parsed.failureClass : null,
      message: typeof parsed.message === "string" ? parsed.message : value,
    };
  } catch {
    return { failureClass: null, message: value };
  }
}
