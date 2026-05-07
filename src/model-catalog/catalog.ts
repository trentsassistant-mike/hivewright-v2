import type { Sql } from "postgres";
import { canonicalModelIdForAdapter } from "@/model-health/model-identity";
import { inferProvider } from "@/model-health/sync-models";
import type { ModelCapabilityScoreInput } from "./capability-scores";
import { upsertModelCapabilityScores } from "./capability-scores";
import {
  buildLiveModelCapabilityScores,
  buildLiveModelCatalogEntries,
  llmStatsBenchmarkMetadataForConfiguredModel,
  staticMetadataForConfiguredModel,
  type LiveMetadataTarget,
} from "./metadata-sources";

export interface ModelCatalogEntry {
  provider: string;
  adapterType: string;
  modelId: string;
  displayName: string;
  family: string | null;
  capabilities: string[];
  local: boolean;
  costPerInputToken: string | null;
  costPerOutputToken: string | null;
  benchmarkQualityScore: number | null;
  routingCostScore: number | null;
  metadataSourceName: string | null;
  metadataSourceUrl: string | null;
}

export interface RefreshModelCatalogMetadataResult {
  catalogUpserted: number;
  hiveRowsLinked: number;
  hiveRowsUpdated: number;
  missingMetadata: number;
  capabilityScoreCount: number;
}

export interface RefreshModelCatalogMetadataInput {
  hiveId?: string;
  fetchLiveMetadata?: boolean;
  fetchImpl?: (url: string | URL) => Promise<Response>;
  metadataEntries?: ModelCatalogEntry[];
  capabilityScores?: ModelCapabilityScoreInput[];
}

type HiveModelForCatalogRow = {
  id: string;
  provider: string;
  adapter_type: string;
  model_id: string;
};

type UpsertedCatalogRow = {
  id: string;
};

type ExistingCatalogMetadataRow = {
  id: string;
  provider: string;
  adapter_type: string;
  model_id: string;
  benchmark_quality_score: string | null;
  cost_per_input_token: string | null;
  cost_per_output_token: string | null;
  routing_cost_score: string | null;
  metadata_source_name: string | null;
  metadata_source_url: string | null;
};

type CatalogIdentityRow = {
  id: string;
  provider: string;
  adapter_type: string;
  model_id: string;
};

type CatalogMetadataTargetRow = {
  provider: string;
  adapter_type: string;
  model_id: string;
  display_name: string;
  family: string | null;
  capabilities: unknown;
  local: boolean;
};

export const CURATED_MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    provider: "openai",
    adapterType: "codex",
    modelId: "openai-codex/gpt-5.5",
    displayName: "GPT-5.5",
    family: "gpt-5",
    capabilities: ["text", "code", "reasoning"],
    local: false,
    costPerInputToken: "0.000005",
    costPerOutputToken: "0.000030",
    benchmarkQualityScore: null,
    routingCostScore: 70,
    metadataSourceName: "OpenAI API pricing and GPT-5.5 evaluations",
    metadataSourceUrl: "https://openai.com/api/pricing/",
  },
  {
    provider: "openai",
    adapterType: "codex",
    modelId: "openai-codex/gpt-5.4",
    displayName: "GPT-5.4",
    family: "gpt-5",
    capabilities: ["text", "code", "reasoning"],
    local: false,
    costPerInputToken: "0.0000025",
    costPerOutputToken: "0.000015",
    benchmarkQualityScore: null,
    routingCostScore: 45,
    metadataSourceName: "OpenAI API pricing",
    metadataSourceUrl: "https://openai.com/api/pricing/",
  },
  {
    provider: "anthropic",
    adapterType: "claude-code",
    modelId: "anthropic/claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    family: "claude-opus",
    capabilities: ["text", "code", "reasoning"],
    local: false,
    costPerInputToken: "0.000005",
    costPerOutputToken: "0.000025",
    benchmarkQualityScore: null,
    routingCostScore: 65,
    metadataSourceName: "Anthropic Opus 4.7 pricing and benchmarks",
    metadataSourceUrl: "https://www.anthropic.com/claude/opus?pubDate=20260410",
  },
  {
    provider: "google",
    adapterType: "gemini",
    modelId: "google/gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    family: "gemini-pro",
    capabilities: ["text", "code", "reasoning"],
    local: false,
    costPerInputToken: "0.000002",
    costPerOutputToken: "0.000012",
    benchmarkQualityScore: null,
    routingCostScore: 40,
    metadataSourceName: "Google Gemini API pricing",
    metadataSourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    provider: "google",
    adapterType: "gemini",
    modelId: "google/gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash Lite Preview",
    family: "gemini-flash",
    capabilities: ["text", "code"],
    local: false,
    costPerInputToken: "0.00000025",
    costPerOutputToken: "0.0000015",
    benchmarkQualityScore: null,
    routingCostScore: 8,
    metadataSourceName: "Google Gemini API pricing",
    metadataSourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    provider: "local",
    adapterType: "ollama",
    modelId: "qwen3:32b",
    displayName: "Qwen3 32B",
    family: "qwen",
    capabilities: ["text", "code"],
    local: true,
    costPerInputToken: "0",
    costPerOutputToken: "0",
    benchmarkQualityScore: null,
    routingCostScore: 0,
    metadataSourceName: "Local Ollama runtime",
    metadataSourceUrl: "https://ollama.com/",
  },
];

export async function upsertModelCatalogEntry(
  sql: Sql,
  entry: ModelCatalogEntry,
  options: { overwriteMetadata?: boolean } = {},
): Promise<string> {
  const normalized = normalizeCatalogEntry(entry);
  const overwriteMetadata = options.overwriteMetadata === true;
  const [row] = await sql<UpsertedCatalogRow[]>`
    INSERT INTO model_catalog (
      provider,
      adapter_type,
      model_id,
      display_name,
      family,
      capabilities,
      local,
      cost_per_input_token,
      cost_per_output_token,
      benchmark_quality_score,
      routing_cost_score,
      metadata_source_name,
      metadata_source_url,
      metadata_last_checked_at,
      updated_at
    )
    VALUES (
      ${normalized.provider},
      ${normalized.adapterType},
      ${normalized.modelId},
      ${normalized.displayName},
      ${normalized.family},
      ${sql.json(normalized.capabilities)},
      ${normalized.local},
      ${normalized.costPerInputToken},
      ${normalized.costPerOutputToken},
      ${normalized.benchmarkQualityScore},
      ${normalized.routingCostScore},
      ${normalized.metadataSourceName},
      ${normalized.metadataSourceUrl},
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, adapter_type, model_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          family = COALESCE(EXCLUDED.family, model_catalog.family),
          capabilities = EXCLUDED.capabilities,
          local = EXCLUDED.local,
          cost_per_input_token = CASE
            WHEN ${overwriteMetadata} AND EXCLUDED.cost_per_input_token IS NOT NULL THEN EXCLUDED.cost_per_input_token
            ELSE COALESCE(EXCLUDED.cost_per_input_token, model_catalog.cost_per_input_token)
          END,
          cost_per_output_token = CASE
            WHEN ${overwriteMetadata} AND EXCLUDED.cost_per_output_token IS NOT NULL THEN EXCLUDED.cost_per_output_token
            ELSE COALESCE(EXCLUDED.cost_per_output_token, model_catalog.cost_per_output_token)
          END,
          benchmark_quality_score = CASE
            WHEN ${overwriteMetadata} AND EXCLUDED.benchmark_quality_score IS NOT NULL THEN EXCLUDED.benchmark_quality_score
            ELSE COALESCE(EXCLUDED.benchmark_quality_score, model_catalog.benchmark_quality_score)
          END,
          routing_cost_score = CASE
            WHEN ${overwriteMetadata} AND EXCLUDED.routing_cost_score IS NOT NULL THEN EXCLUDED.routing_cost_score
            ELSE COALESCE(EXCLUDED.routing_cost_score, model_catalog.routing_cost_score)
          END,
          metadata_source_name = CASE
            WHEN ${overwriteMetadata} AND EXCLUDED.metadata_source_name IS NOT NULL THEN EXCLUDED.metadata_source_name
            ELSE COALESCE(EXCLUDED.metadata_source_name, model_catalog.metadata_source_name)
          END,
          metadata_source_url = CASE
            WHEN ${overwriteMetadata} AND EXCLUDED.metadata_source_url IS NOT NULL THEN EXCLUDED.metadata_source_url
            ELSE COALESCE(EXCLUDED.metadata_source_url, model_catalog.metadata_source_url)
          END,
          metadata_last_checked_at = NOW(),
          updated_at = NOW()
    RETURNING id
  `;

  if (!row) throw new Error("model catalog upsert did not return a row");
  return row.id;
}

export async function refreshModelCatalogMetadata(
  sql: Sql,
  input: RefreshModelCatalogMetadataInput = {},
): Promise<RefreshModelCatalogMetadataResult> {
  for (const entry of CURATED_MODEL_CATALOG) {
    await upsertModelCatalogEntry(sql, entry);
  }

  const liveTargets = input.fetchLiveMetadata ? await loadLiveMetadataTargets(sql) : [];
  const liveEntries = input.metadataEntries ??
    (input.fetchLiveMetadata ? await buildLiveModelCatalogEntries(input.fetchImpl, liveTargets) : []);
  const liveCapabilityScores = input.fetchLiveMetadata
    ? await buildLiveModelCapabilityScores(input.fetchImpl, liveTargets)
    : [];

  for (const entry of liveEntries) {
    await upsertModelCatalogEntry(sql, entry, { overwriteMetadata: true });
  }

  await fillKnownMetadataForExistingCatalogRows(sql);
  await clearEstimatedMetadata(sql);
  if (input.fetchLiveMetadata) {
    await fillLlmStatsBenchmarkMetadataForExistingCatalogRows(sql, input.fetchImpl);
  }
  await backfillAliasAndLocalQuality(sql);

  const capabilityScores = [
    ...liveCapabilityScores,
    ...(input.capabilityScores ?? []),
  ];
  const capabilityScoreCount = capabilityScores.length
    ? await upsertModelCapabilityScores(
      sql,
      await attachCatalogIdsToCapabilityScores(sql, capabilityScores),
    )
    : 0;

  if (input.fetchLiveMetadata) {
    await retireUnbenchmarkedAutoDiscoveredModels(sql);
  }

  const hiveRows = input.hiveId
    ? await sql<HiveModelForCatalogRow[]>`
        SELECT id, provider, adapter_type, model_id
        FROM hive_models
        WHERE hive_id = ${input.hiveId}
      `
    : await sql<HiveModelForCatalogRow[]>`
        SELECT id, provider, adapter_type, model_id
        FROM hive_models
      `;

  let linked = 0;
  let updated = 0;
  let missing = 0;

  for (const row of hiveRows) {
    const normalized = normalizeHiveModelIdentity(row);
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
      WHERE provider = ${normalized.provider}
        AND adapter_type = ${normalized.adapterType}
        AND model_id = ${normalized.modelId}
      LIMIT 1
    `;

    if (!catalog) {
      missing += 1;
      continue;
    }

    const hasNumericMetadata = catalog.cost_per_input_token !== null ||
      catalog.cost_per_output_token !== null ||
      catalog.benchmark_quality_score !== null ||
      catalog.routing_cost_score !== null;
    const hasCapabilityMetadata = await hasCapabilityScoresForModel(sql, {
      provider: normalized.provider,
      adapterType: normalized.adapterType,
      modelId: normalized.modelId,
    });

    await sql`
      UPDATE hive_models
      SET model_catalog_id = ${catalog.id},
          capabilities = ${sql.json(catalog.capabilities ?? [])},
          cost_per_input_token = ${catalog.cost_per_input_token},
          cost_per_output_token = ${catalog.cost_per_output_token},
          benchmark_quality_score = ${catalog.benchmark_quality_score},
          routing_cost_score = ${catalog.routing_cost_score},
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
    linked += 1;
    if (hasNumericMetadata || hasCapabilityMetadata) {
      updated += 1;
    } else {
      missing += 1;
    }
  }

  return {
    catalogUpserted: CURATED_MODEL_CATALOG.length,
    hiveRowsLinked: linked,
    hiveRowsUpdated: updated,
    missingMetadata: missing,
    capabilityScoreCount,
  };
}

async function hasCapabilityScoresForModel(
  sql: Sql,
  input: { provider: string; adapterType: string; modelId: string },
) {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM model_capability_scores
      WHERE provider = ${input.provider}
        AND adapter_type = ${input.adapterType}
        AND LOWER(canonical_model_id) = LOWER(${input.modelId})
    ) AS exists
  `;
  return row?.exists === true;
}

async function attachCatalogIdsToCapabilityScores(
  sql: Sql,
  scores: ModelCapabilityScoreInput[],
): Promise<ModelCapabilityScoreInput[]> {
  const rows = await sql<CatalogIdentityRow[]>`
    SELECT id, provider, adapter_type, model_id
    FROM model_catalog
  `;
  const catalogIds = new Map<string, string>();

  for (const row of rows) {
    const adapterType = row.adapter_type.trim();
    const modelId = canonicalModelIdForAdapter(adapterType, row.model_id.trim());
    catalogIds.set(identityKey({
      provider: row.provider,
      adapterType,
      modelId,
    }), row.id);
  }

  return scores.map((score) => {
    const adapterType = score.adapterType.trim();
    const modelId = canonicalModelIdForAdapter(adapterType, score.modelId.trim());
    const provider = score.provider.trim().toLowerCase();
    const catalogId = catalogIds.get(identityKey({ provider, adapterType, modelId }));

    return {
      ...score,
      modelCatalogId: catalogId ?? score.modelCatalogId,
      provider,
      adapterType,
      modelId,
      canonicalModelId: modelId,
    };
  });
}

async function fillKnownMetadataForExistingCatalogRows(sql: Sql) {
  const rows = await sql<ExistingCatalogMetadataRow[]>`
    SELECT
      id,
      provider,
      adapter_type,
      model_id,
      benchmark_quality_score,
      cost_per_input_token,
      cost_per_output_token,
      routing_cost_score,
      metadata_source_name,
      metadata_source_url
    FROM model_catalog
  `;

  for (const row of rows) {
    const metadata = staticMetadataForConfiguredModel({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    });
    if (!metadata) continue;

    await sql`
      UPDATE model_catalog
      SET cost_per_input_token = COALESCE(model_catalog.cost_per_input_token, ${metadata.costPerInputToken}),
          cost_per_output_token = COALESCE(model_catalog.cost_per_output_token, ${metadata.costPerOutputToken}),
          benchmark_quality_score = COALESCE(model_catalog.benchmark_quality_score, ${metadata.benchmarkQualityScore}),
          routing_cost_score = COALESCE(model_catalog.routing_cost_score, ${metadata.routingCostScore}),
          metadata_source_name = COALESCE(model_catalog.metadata_source_name, ${metadata.metadataSourceName}),
          metadata_source_url = COALESCE(model_catalog.metadata_source_url, ${metadata.metadataSourceUrl}),
          metadata_last_checked_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }
}

async function clearEstimatedMetadata(sql: Sql) {
  await sql`
    UPDATE model_catalog
    SET cost_per_input_token = NULL,
        cost_per_output_token = NULL,
        benchmark_quality_score = NULL,
        routing_cost_score = NULL,
        metadata_source_name = NULL,
        metadata_source_url = NULL,
        metadata_last_checked_at = NOW(),
        updated_at = NOW()
    WHERE metadata_source_name = 'Estimated metadata from discovered model family'
  `;

  await sql`
    UPDATE model_catalog
    SET cost_per_input_token = NULL,
        cost_per_output_token = NULL,
        benchmark_quality_score = NULL,
        routing_cost_score = NULL,
        metadata_last_checked_at = NOW(),
        updated_at = NOW()
    WHERE metadata_source_name IN (
      'OpenAI public model docs',
      'Anthropic public model docs',
      'Google Gemini public model docs',
      'Gemini public model docs'
    )
      AND (
        cost_per_input_token IS NOT NULL
        OR cost_per_output_token IS NOT NULL
        OR benchmark_quality_score IS NOT NULL
        OR routing_cost_score IS NOT NULL
      )
  `;

  await sql`
    UPDATE model_catalog
    SET benchmark_quality_score = NULL,
        metadata_last_checked_at = NOW(),
        updated_at = NOW()
    WHERE (provider = 'local' OR adapter_type = 'ollama' OR model_id LIKE 'ollama/%')
      AND metadata_source_name IN (
        'Local Ollama runtime',
        'Ollama Tags API'
      )
      AND benchmark_quality_score IS NOT NULL
  `;
}

async function loadLiveMetadataTargets(sql: Sql): Promise<LiveMetadataTarget[]> {
  const rows = await sql<CatalogMetadataTargetRow[]>`
    SELECT
      provider,
      adapter_type,
      model_id,
      display_name,
      family,
      capabilities,
      local
    FROM model_catalog
  `;

  return rows.map((row) => ({
    provider: row.provider,
    adapterType: row.adapter_type,
    modelId: row.model_id,
    displayName: row.display_name,
    family: row.family,
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.filter((capability): capability is string => typeof capability === "string")
      : [],
    local: row.local,
  }));
}

async function fillLlmStatsBenchmarkMetadataForExistingCatalogRows(
  sql: Sql,
  fetchImpl?: (url: string | URL) => Promise<Response>,
) {
  const rows = await sql<ExistingCatalogMetadataRow[]>`
    SELECT
      id,
      provider,
      adapter_type,
      model_id,
      benchmark_quality_score,
      cost_per_input_token,
      cost_per_output_token,
      routing_cost_score,
      metadata_source_name,
      metadata_source_url
    FROM model_catalog
    WHERE provider = 'local'
      OR adapter_type = 'ollama'
      OR model_id LIKE 'ollama/%'
  `;

  for (const row of rows) {
    if (
      row.benchmark_quality_score !== null &&
      row.metadata_source_name !== null &&
      !row.metadata_source_name.toLowerCase().includes("local ollama")
    ) {
      continue;
    }

    const metadata = await llmStatsBenchmarkMetadataForConfiguredModel({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    }, fetchImpl);
    if (!metadata) continue;

    await sql`
      UPDATE model_catalog
      SET benchmark_quality_score = ${metadata.benchmarkQualityScore},
          metadata_source_name = ${metadata.metadataSourceName},
          metadata_source_url = ${metadata.metadataSourceUrl},
          metadata_last_checked_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }
}

async function backfillAliasAndLocalQuality(sql: Sql) {
  const rows = await sql<ExistingCatalogMetadataRow[]>`
    SELECT
      id,
      provider,
      adapter_type,
      model_id,
      benchmark_quality_score,
      cost_per_input_token,
      cost_per_output_token,
      routing_cost_score,
      metadata_source_name,
      metadata_source_url
    FROM model_catalog
  `;

  const byIdentity = new Map<string, ExistingCatalogMetadataRow[]>();
  for (const row of rows) {
    const key = identityKey({
      provider: inferProvider(row.adapter_type, canonicalModelIdForAdapter(row.adapter_type, row.model_id)),
      adapterType: row.adapter_type,
      modelId: canonicalModelIdForAdapter(row.adapter_type, row.model_id),
    });
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), row]);
  }

  for (const group of byIdentity.values()) {
    const source = group.find((row) => row.benchmark_quality_score !== null);
    if (!source) continue;

    for (const row of group) {
      if (row.benchmark_quality_score !== null) continue;
      await sql`
        UPDATE model_catalog
        SET benchmark_quality_score = ${source.benchmark_quality_score},
            metadata_source_name = COALESCE(${source.metadata_source_name}, model_catalog.metadata_source_name),
            metadata_source_url = COALESCE(${source.metadata_source_url}, model_catalog.metadata_source_url),
            metadata_last_checked_at = NOW(),
            updated_at = NOW()
        WHERE id = ${row.id}
      `;
    }
  }

}

async function retireUnbenchmarkedAutoDiscoveredModels(sql: Sql) {
  const retiredRows = await sql<{
    id: string;
    provider: string;
    adapter_type: string;
    model_id: string;
  }[]>`
    WITH unbenchmarked AS (
      SELECT mc.id
      FROM model_catalog mc
      WHERE mc.stale_since IS NULL
        AND mc.discovery_source IN (
          'openai_public_model_docs',
          'anthropic_public_model_docs',
          'gemini_public_model_docs',
          'ollama_tags_api'
        )
        AND mc.benchmark_quality_score IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM model_capability_scores mcs
          WHERE mcs.provider = mc.provider
            AND mcs.adapter_type = mc.adapter_type
            AND LOWER(mcs.canonical_model_id) = LOWER(mc.model_id)
        )
    )
    UPDATE model_catalog mc
    SET stale_since = NOW(),
        updated_at = NOW()
    FROM unbenchmarked
    WHERE mc.id = unbenchmarked.id
    RETURNING mc.id, mc.provider, mc.adapter_type, mc.model_id
  `;
  const retiredIds = retiredRows.map((row) => row.id);
  if (retiredIds.length === 0) return;

  for (const row of retiredRows) {
    await sql`
      DELETE FROM hive_models
      WHERE provider = ${row.provider}
        AND adapter_type = ${row.adapter_type}
        AND model_id = ${row.model_id}
        AND auto_discovered = true
        AND owner_disabled_at IS NULL
    `;
  }

  await sql`
    DELETE FROM model_catalog mc
    WHERE mc.id = ANY(${retiredIds}::uuid[])
      AND NOT EXISTS (
        SELECT 1
        FROM hive_models hm
        WHERE hm.model_catalog_id = mc.id
      )
  `;
}

function identityKey(input: { provider: string; adapterType: string; modelId: string }) {
  return [
    input.provider.trim().toLowerCase(),
    input.adapterType.trim().toLowerCase(),
    input.modelId.trim().toLowerCase(),
  ].join(":");
}

function normalizeCatalogEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
  const adapterType = entry.adapterType.trim();
  const modelId = canonicalModelIdForAdapter(adapterType, entry.modelId.trim());
  return {
    ...entry,
    provider: entry.provider.trim().toLowerCase(),
    adapterType,
    modelId,
    displayName: entry.displayName.trim(),
    family: entry.family?.trim() || null,
    capabilities: [...new Set(entry.capabilities.map((capability) => capability.trim()).filter(Boolean))],
  };
}

function normalizeHiveModelIdentity(row: HiveModelForCatalogRow) {
  const adapterType = row.adapter_type.trim();
  const modelId = canonicalModelIdForAdapter(adapterType, row.model_id.trim());
  return {
    provider: inferProvider(adapterType, modelId),
    adapterType,
    modelId,
  };
}
