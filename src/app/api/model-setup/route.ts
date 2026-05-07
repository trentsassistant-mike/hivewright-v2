import { canAccessHive } from "@/auth/users";
import {
  canonicalModelIdForAdapter,
  configuredModelIdentityKey,
} from "@/model-health/model-identity";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { loadModelHealthByIdentity } from "@/model-health/stored-health";
import type {
  ModelCapabilityAxis,
  ModelCapabilityConfidence,
  ModelCapabilityScoreView,
} from "@/model-catalog/capability-scores";
import {
  findModelCatalogRemovalBlockers,
  lockModelCatalogRemovalBlockerTables,
  setModelCatalogCleanupLockTimeout,
} from "@/model-discovery/service";
import { routeKeyForModel } from "@/model-routing/registry";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

type CatalogUsageRow = {
  model_catalog_id: string | null;
  provider: string;
  adapter_type: string;
  model_id: string;
  display_name: string;
  family: string | null;
  catalog_capabilities: string[];
  local: boolean;
  catalog_cost_per_input_token: string | null;
  catalog_cost_per_output_token: string | null;
  catalog_benchmark_quality_score: string | number | null;
  catalog_routing_cost_score: string | number | null;
  metadata_source_name: string | null;
  metadata_source_url: string | null;
  metadata_last_checked_at: Date | null;
  discovery_source: string | null;
  first_seen_at: Date | null;
  last_seen_at: Date | null;
  stale_since: Date | null;
  deprecated_at: Date | null;
  hive_model_id: string | null;
  credential_id: string | null;
  credential_name: string | null;
  credential_fingerprint: string | null;
  hive_enabled: boolean | null;
  owner_disabled_at: Date | null;
  owner_disabled_reason: string | null;
  fallback_priority: number | null;
};

type CredentialRow = {
  id: string;
  hive_id: string | null;
  name: string;
  key: string;
  roles_allowed: string[] | null;
  expires_at: Date | null;
  created_at: Date;
};

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

type ModelSetupViewModel = {
  modelCatalogId: string | null;
  hiveModelId: string | null;
  [key: string]: unknown;
};

const OWNER_DISABLED_REASON = "Disabled by owner in model setup";

async function requireHiveAccess(
  user: { id: string; isSystemOwner: boolean },
  hiveId: string,
) {
  if (user.isSystemOwner) return null;
  const hasAccess = await canAccessHive(sql, user.id, hiveId);
  return hasAccess ? null : jsonError("Forbidden: hive access required", 403);
}

async function validateCredentialForHive(credentialId: string | null, hiveId: string) {
  if (!credentialId) return null;
  const [credential] = await sql<{ id: string; hive_id: string | null }[]>`
    SELECT id, hive_id
    FROM credentials
    WHERE id = ${credentialId}
    LIMIT 1
  `;
  if (!credential) return jsonError("credential not found", 404);
  if (credential.hive_id && credential.hive_id !== hiveId) {
    return jsonError("credential must be global or belong to the selected hive", 400);
  }
  return null;
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const params = parseSearchParams(request.url);
  const hiveId = params.get("hiveId");
  if (!hiveId) return jsonError("hiveId is required", 400);

  const denied = await requireHiveAccess(authz.user, hiveId);
  if (denied) return denied;

  try {
    const view = await loadModelSetupView(hiveId);
    return jsonOk({ hiveId, ...view });
  } catch (err) {
    console.error("[model-setup GET] failed:", err);
    return jsonError("Failed to fetch model setup", 500);
  }
}

export async function PATCH(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const hiveId = typeof body.hiveId === "string" ? body.hiveId.trim() : "";
  const modelCatalogId = typeof body.modelCatalogId === "string" ? body.modelCatalogId.trim() : "";
  const hiveModelId = typeof body.hiveModelId === "string" ? body.hiveModelId.trim() : "";
  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!modelCatalogId && !hiveModelId) return jsonError("modelCatalogId or hiveModelId is required", 400);

  const denied = await requireHiveAccess(authz.user, hiveId);
  if (denied) return denied;

  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  const fallbackPriority = typeof body.fallbackPriority === "number"
    ? Math.max(1, Math.min(1000, Math.trunc(body.fallbackPriority)))
    : 100;
  const credentialId = typeof body.credentialId === "string" && body.credentialId.trim()
    ? body.credentialId.trim()
    : null;

  try {
    const credentialDenied = await validateCredentialForHive(credentialId, hiveId);
    if (credentialDenied) return credentialDenied;

    if (hiveModelId && !modelCatalogId) {
      const [existing] = await sql<{ id: string }[]>`
        SELECT id
        FROM hive_models
        WHERE id = ${hiveModelId}
          AND hive_id = ${hiveId}
        LIMIT 1
      `;
      if (!existing) return jsonError("hive model row not found", 404);

      await sql`
        UPDATE hive_models
        SET credential_id = ${credentialId},
            fallback_priority = ${fallbackPriority},
            enabled = ${enabled},
            owner_disabled_at = CASE
              WHEN ${enabled} THEN NULL
              ELSE COALESCE(owner_disabled_at, NOW())
            END,
            owner_disabled_reason = CASE
              WHEN ${enabled} THEN NULL
              ELSE COALESCE(owner_disabled_reason, ${OWNER_DISABLED_REASON})
            END,
            updated_at = NOW()
        WHERE id = ${hiveModelId}
          AND hive_id = ${hiveId}
      `;

      const view = await loadModelSetupView(hiveId);
      const model = view.models.find((candidate) => candidate.hiveModelId === hiveModelId);
      return jsonOk({ hiveId, model, models: view.models, updated: true });
    }

    const [catalog] = await sql<{
      id: string;
      provider: string;
      adapter_type: string;
      model_id: string;
      capabilities: string[];
      cost_per_input_token: string | null;
      cost_per_output_token: string | null;
      benchmark_quality_score: string | null;
      routing_cost_score: string | null;
    }[]>`
      SELECT
        id,
        provider,
        adapter_type,
        model_id,
        capabilities,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score
      FROM model_catalog
      WHERE id = ${modelCatalogId}
      LIMIT 1
    `;
    if (!catalog) return jsonError("model catalog row not found", 404);

    await sql`
      INSERT INTO hive_models (
        hive_id,
        model_catalog_id,
        provider,
        model_id,
        adapter_type,
        credential_id,
        capabilities,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score,
        fallback_priority,
        enabled,
        owner_disabled_at,
        owner_disabled_reason,
        updated_at
      )
      VALUES (
        ${hiveId},
        ${catalog.id},
        ${catalog.provider},
        ${catalog.model_id},
        ${catalog.adapter_type},
        ${credentialId},
        ${sql.json(catalog.capabilities ?? [])},
        ${catalog.cost_per_input_token},
        ${catalog.cost_per_output_token},
        ${catalog.benchmark_quality_score},
        ${catalog.routing_cost_score},
        ${fallbackPriority},
        ${enabled},
        CASE WHEN ${enabled} THEN NULL ELSE NOW() END,
        CASE WHEN ${enabled} THEN NULL ELSE ${OWNER_DISABLED_REASON} END,
        NOW()
      )
      ON CONFLICT (hive_id, provider, model_id) DO UPDATE
        SET model_catalog_id = EXCLUDED.model_catalog_id,
            credential_id = EXCLUDED.credential_id,
            capabilities = EXCLUDED.capabilities,
            cost_per_input_token = EXCLUDED.cost_per_input_token,
            cost_per_output_token = EXCLUDED.cost_per_output_token,
            benchmark_quality_score = EXCLUDED.benchmark_quality_score,
            routing_cost_score = EXCLUDED.routing_cost_score,
            fallback_priority = EXCLUDED.fallback_priority,
            enabled = EXCLUDED.enabled,
            owner_disabled_at = CASE
              WHEN NOT EXCLUDED.enabled THEN COALESCE(hive_models.owner_disabled_at, NOW())
              ELSE NULL
            END,
            owner_disabled_reason = CASE
              WHEN NOT EXCLUDED.enabled THEN COALESCE(hive_models.owner_disabled_reason, ${OWNER_DISABLED_REASON})
              ELSE NULL
            END,
            updated_at = NOW()
    `;

    const view = await loadModelSetupView(hiveId);
    const model = view.models.find((candidate) => candidate.modelCatalogId === modelCatalogId);
    return jsonOk({ hiveId, model, models: view.models, updated: true });
  } catch (err) {
    console.error("[model-setup PATCH] failed:", err);
    return jsonError("Failed to update model setup", 500);
  }
}

export async function DELETE(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) return jsonError("Forbidden: system owner role required", 403);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError("JSON body must be an object", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const hiveId = typeof body.hiveId === "string" ? body.hiveId.trim() : "";
  const modelCatalogId = typeof body.modelCatalogId === "string" ? body.modelCatalogId.trim() : "";
  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!modelCatalogId) return jsonError("modelCatalogId is required", 400);

  const denied = await requireHiveAccess(authz.user, hiveId);
  if (denied) return denied;

  try {
    const result = await sql.begin(async (tx) => {
      await setModelCatalogCleanupLockTimeout(tx);
      const [hive] = await tx<{ id: string }[]>`
        SELECT id
        FROM hives
        WHERE id = ${hiveId}
        LIMIT 1
      `;
      if (!hive) return { status: "missing_hive" as const };

      const [catalog] = await tx<{
        id: string;
        stale_since: Date | null;
        deprecated_at: Date | null;
      }[]>`
        SELECT id, stale_since, deprecated_at
        FROM model_catalog
        WHERE id = ${modelCatalogId}
        FOR UPDATE
      `;
      if (!catalog) return { status: "missing_catalog" as const };
      if (!catalog.stale_since && !catalog.deprecated_at) {
        return { status: "fresh_catalog" as const };
      }

      await lockModelCatalogRemovalBlockerTables(tx);
      const blockers = await findModelCatalogRemovalBlockers(tx, modelCatalogId);
      if (blockers.length > 0) {
        return { status: "blocked" as const, blockers };
      }

      await tx`
        DELETE FROM model_catalog
        WHERE id = ${modelCatalogId}
      `;
      return { status: "deleted" as const };
    });

    if (result.status === "missing_hive") return jsonError("hive not found", 404);
    if (result.status === "missing_catalog") return jsonError("model catalog row not found", 404);
    if (result.status === "fresh_catalog") {
      return jsonError("model catalog row must be stale or deprecated before deletion", 400);
    }
    if (result.status === "blocked") {
      return Response.json({
        error: "model catalog row is still referenced",
        data: { blockers: result.blockers },
      }, { status: 409 });
    }

    return jsonOk({ hiveId, modelCatalogId, deleted: true });
  } catch (err) {
    if (isPostgresLockTimeout(err)) {
      return jsonError("model catalog cleanup is busy; retry shortly", 409);
    }
    console.error("[model-setup DELETE] failed:", err);
    return jsonError("Failed to delete model catalog row", 500);
  }
}

function isPostgresLockTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "55P03";
}

async function loadModelSetupView(hiveId: string) {
  const credentials = await sql<CredentialRow[]>`
    SELECT id, hive_id, name, key, roles_allowed, expires_at, created_at
    FROM credentials
    WHERE hive_id = ${hiveId} OR hive_id IS NULL
    ORDER BY created_at DESC
  `;

  const rows = await sql<CatalogUsageRow[]>`
    SELECT
      mc.id AS model_catalog_id,
      mc.provider,
      mc.adapter_type,
      mc.model_id,
      mc.display_name,
      mc.family,
      mc.capabilities AS catalog_capabilities,
      mc.local,
      mc.cost_per_input_token AS catalog_cost_per_input_token,
      mc.cost_per_output_token AS catalog_cost_per_output_token,
      mc.benchmark_quality_score AS catalog_benchmark_quality_score,
      mc.routing_cost_score AS catalog_routing_cost_score,
      mc.metadata_source_name,
      mc.metadata_source_url,
      mc.metadata_last_checked_at,
      mc.discovery_source,
      mc.first_seen_at,
      mc.last_seen_at,
      mc.stale_since,
      mc.deprecated_at,
      hm.id AS hive_model_id,
      hm.credential_id,
      c.name AS credential_name,
      c.fingerprint AS credential_fingerprint,
      hm.enabled AS hive_enabled,
      hm.owner_disabled_at,
      hm.owner_disabled_reason,
      hm.fallback_priority
    FROM model_catalog mc
    LEFT JOIN hive_models hm
      ON hm.model_catalog_id = mc.id
      AND hm.hive_id = ${hiveId}
    LEFT JOIN credentials c ON c.id = hm.credential_id
    UNION ALL
    SELECT
      NULL AS model_catalog_id,
      hm.provider,
      hm.adapter_type,
      hm.model_id,
      hm.model_id AS display_name,
      NULL AS family,
      COALESCE(hm.capabilities, '[]'::jsonb) AS catalog_capabilities,
      hm.provider = 'local' OR hm.adapter_type = 'ollama' AS local,
      hm.cost_per_input_token AS catalog_cost_per_input_token,
      hm.cost_per_output_token AS catalog_cost_per_output_token,
      hm.benchmark_quality_score AS catalog_benchmark_quality_score,
      hm.routing_cost_score AS catalog_routing_cost_score,
      NULL AS metadata_source_name,
      NULL AS metadata_source_url,
      NULL AS metadata_last_checked_at,
      NULL AS discovery_source,
      NULL AS first_seen_at,
      hm.last_seen_at,
      NULL AS stale_since,
      NULL AS deprecated_at,
      hm.id AS hive_model_id,
      hm.credential_id,
      c.name AS credential_name,
      c.fingerprint AS credential_fingerprint,
      hm.enabled AS hive_enabled,
      hm.owner_disabled_at,
      hm.owner_disabled_reason,
      hm.fallback_priority
    FROM hive_models hm
    LEFT JOIN credentials c ON c.id = hm.credential_id
    WHERE hm.hive_id = ${hiveId}
      AND hm.model_catalog_id IS NULL
    ORDER BY provider ASC, adapter_type ASC, model_id ASC
  `;

  const collapsedRows = collapseModelSetupRows(rows);
  const capabilityScoresByModel = await loadCapabilityScoresByModel(collapsedRows);

  const models: ModelSetupViewModel[] = [];
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
    const failure = parseFailureReason(health?.last_failure_reason ?? null);

    models.push({
      modelCatalogId: row.model_catalog_id,
      hiveModelId: row.hive_model_id,
      routeKey: routeKeyForModel({
        provider: row.provider,
        adapterType: row.adapter_type,
        model: row.model_id,
      }),
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.model_id,
      displayName: row.display_name,
      family: row.family,
      capabilities: row.catalog_capabilities ?? [],
      local: row.local,
      hiveEnabled: row.hive_enabled ?? false,
      ownerDisabledAt: row.owner_disabled_at,
      ownerDisabledReason: row.owner_disabled_reason,
      credentialId: row.credential_id,
      credentialName: row.credential_name,
      healthFingerprint,
      fallbackPriority: row.fallback_priority ?? 100,
      costPerInputToken: row.catalog_cost_per_input_token,
      costPerOutputToken: row.catalog_cost_per_output_token,
      benchmarkQualityScore: asNullableNumber(row.catalog_benchmark_quality_score),
      routingCostScore: asNullableNumber(row.catalog_routing_cost_score),
      capabilityScores: capabilityScoresByModel.get(capabilityScoreKey(row)) ?? [],
      metadataSourceName: row.metadata_source_name,
      metadataSourceUrl: row.metadata_source_url,
      metadataLastCheckedAt: row.metadata_last_checked_at,
      discoverySource: row.discovery_source,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      staleSince: row.stale_since,
      deprecatedAt: row.deprecated_at,
      status: normalizeHealthStatus(health?.status),
      lastProbedAt: health?.last_probed_at ?? null,
      lastFailedAt: health?.last_failed_at ?? null,
      lastFailureReason: health?.last_failure_reason ?? null,
      failureClass: failure.failureClass,
      failureMessage: failure.message,
      nextProbeAt: health?.next_probe_at ?? null,
      latencyMs: health?.latency_ms ?? null,
      sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
    });
  }

  return {
    credentials: credentials.map((credential) => ({
      id: credential.id,
      hiveId: credential.hive_id,
      name: credential.name,
      key: credential.key,
      rolesAllowed: credential.roles_allowed ?? [],
      expiresAt: credential.expires_at,
      createdAt: credential.created_at,
    })),
    models,
  };
}

async function loadCapabilityScoresByModel(
  rows: CatalogUsageRow[],
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

  const scoresByModel = new Map<string, ModelCapabilityScoreView[]>();
  for (const row of scoreRows) {
    const key = capabilityScoreKey({
      provider: row.provider,
      adapter_type: row.adapter_type,
      model_id: row.canonical_model_id,
    });
    if (!keySet.has(key)) continue;

    const score = capabilityScoreViewFromRow(row);
    scoresByModel.set(key, [...(scoresByModel.get(key) ?? []), score]);
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
    confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
    Number(b.updatedAt?.getTime() ?? 0) - Number(a.updatedAt?.getTime() ?? 0) ||
    a.source.localeCompare(b.source) ||
    a.benchmarkName.localeCompare(b.benchmarkName);
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

function collapseModelSetupRows(rows: CatalogUsageRow[]): CatalogUsageRow[] {
  const groups = new Map<string, CatalogUsageRow[]>();
  for (const row of rows) {
    const key = configuredModelIdentityKey({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    });
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((group) => {
    const metadataRow = [...group].sort(compareModelSetupMetadataRows)[0] ?? group[0];
    const usageRow = [...group].sort(compareModelSetupUsageRows)[0] ?? metadataRow;
    return {
      ...metadataRow,
      hive_model_id: usageRow.hive_model_id,
      credential_id: usageRow.credential_id,
      credential_name: usageRow.credential_name,
      credential_fingerprint: usageRow.credential_fingerprint,
      hive_enabled: usageRow.hive_enabled,
      owner_disabled_at: usageRow.owner_disabled_at,
      owner_disabled_reason: usageRow.owner_disabled_reason,
      fallback_priority: usageRow.fallback_priority,
    };
  });
}

function compareModelSetupMetadataRows(a: CatalogUsageRow, b: CatalogUsageRow) {
  return modelSetupMetadataScore(b) - modelSetupMetadataScore(a);
}

function compareModelSetupUsageRows(a: CatalogUsageRow, b: CatalogUsageRow) {
  return modelSetupUsageScore(b) - modelSetupUsageScore(a);
}

function modelSetupMetadataScore(row: CatalogUsageRow) {
  let score = 0;
  if (row.model_catalog_id) score += 40;
  if (isCanonicalSetupModelId(row)) score += 20;
  if (row.catalog_cost_per_input_token !== null || row.catalog_cost_per_output_token !== null) score += 12;
  if (row.catalog_benchmark_quality_score !== null || row.catalog_routing_cost_score !== null) score += 12;
  if (row.metadata_source_name || row.metadata_source_url) score += 8;
  return score;
}

function modelSetupUsageScore(row: CatalogUsageRow) {
  let score = 0;
  if (row.hive_model_id) score += 40;
  if (row.hive_enabled === true) score += 20;
  if (isCanonicalSetupModelId(row)) score += 12;
  if (row.credential_id) score += 8;
  score += Math.max(0, 1000 - (row.fallback_priority ?? 1000)) / 1000;
  return score;
}

function isCanonicalSetupModelId(row: CatalogUsageRow) {
  return row.model_id === canonicalModelIdForAdapter(row.adapter_type, row.model_id);
}

function normalizeHealthStatus(value: string | null | undefined) {
  if (value === "healthy" || value === "unhealthy") return value;
  return "unknown";
}

function asNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
