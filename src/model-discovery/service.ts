import type { Sql, TransactionSql } from "postgres";
import { canonicalModelIdForAdapter } from "@/model-health/model-identity";
import { MODEL_ROUTING_ADAPTER_CONFIG_TYPE } from "@/model-routing/policy";
import { routeKeyForModel } from "@/model-routing/registry";
import type {
  DiscoveredModel,
  ModelDiscoveryImportInput,
  ModelDiscoveryImportResult,
} from "./types";

interface DiscoveryRunRow {
  id: string;
}

interface CatalogRow {
  id: string;
  provider: string;
  adapter_type: string;
  model_id: string;
}

interface CountRow {
  count: string;
}

interface RoleModelReferenceRow {
  adapter_type: string;
  recommended_model: string | null;
  fallback_adapter_type: string | null;
  fallback_model: string | null;
}

interface TaskModelReferenceRow {
  adapter_override: string | null;
  adapter_used: string | null;
  status: string;
  role_adapter_type: string | null;
  role_fallback_adapter_type: string | null;
  model_override: string | null;
  model_used: string | null;
}

interface AdapterConfigRow {
  config: unknown;
}

interface HiveModelUpsertRow {
  id: string;
  enabled: boolean;
  owner_disabled_at: Date | null;
  inserted: boolean;
  previous_enabled: boolean | null;
}

type SqlExecutor = Sql | TransactionSql;

interface NormalizedDiscoveredModel extends DiscoveredModel {
  provider: string;
  adapterType: string;
  modelId: string;
  family: string | null;
  costPerInputToken: string | null;
  costPerOutputToken: string | null;
  benchmarkQualityScore: number | null;
  routingCostScore: number | null;
  metadataSourceName: string | null;
  metadataSourceUrl: string | null;
}

export async function runModelDiscoveryImport(
  sql: Sql,
  input: ModelDiscoveryImportInput,
): Promise<ModelDiscoveryImportResult> {
  return sql.begin(async (tx) => runModelDiscoveryImportInTransaction(tx, input));
}

async function runModelDiscoveryImportInTransaction(
  sql: SqlExecutor,
  input: ModelDiscoveryImportInput,
): Promise<ModelDiscoveryImportResult> {
  const provider = input.provider.trim().toLowerCase();
  const adapterType = input.adapterType.trim();
  const models = input.models.map((model) => normalizeModel(model));
  const modelIds = models.map((model) => model.modelId);
  const [run] = await sql<DiscoveryRunRow[]>`
    INSERT INTO model_discovery_runs (
      hive_id,
      adapter_type,
      provider,
      credential_id,
      source,
      models_seen
    )
    VALUES (
      ${input.hiveId},
      ${adapterType},
      ${provider},
      ${input.credentialId ?? null},
      ${input.source},
      ${models.length}
    )
    RETURNING id
  `;

  if (!run) throw new Error("model discovery run insert did not return a row");

  const catalogIds: string[] = [];
  let modelsAutoEnabled = 0;

  for (const model of models) {
    const catalogId = await upsertModelCatalog(sql, model, {
      source: input.source,
      runId: run.id,
    });
    catalogIds.push(catalogId);

    const hiveModel = await upsertHiveModel(sql, model, {
      hiveId: input.hiveId,
      credentialId: input.assignCredentialToHiveModels === false
        ? null
        : input.credentialId ?? null,
      catalogId,
      runId: run.id,
    });
    const newlyEnabled = hiveModel.inserted || hiveModel.previous_enabled === false;
    if (
      newlyEnabled &&
      hiveModel.enabled &&
      hiveModel.owner_disabled_at === null &&
      shouldAutoEnable(model)
    ) {
      modelsAutoEnabled += 1;
    }
  }

  const modelsMarkedStale = await markMissingModelsStale(sql, {
    provider,
    adapterType,
    source: input.source,
    runId: run.id,
    modelIds,
  });

  await sql`
    UPDATE model_discovery_runs
    SET status = 'completed',
        models_imported = ${models.length},
        models_auto_enabled = ${modelsAutoEnabled},
        models_marked_stale = ${modelsMarkedStale},
        completed_at = NOW()
    WHERE id = ${run.id}
  `;

  return {
    runId: run.id,
    catalogIds,
    modelsSeen: models.length,
    modelsImported: models.length,
    modelsAutoEnabled,
    modelsMarkedStale,
  };
}

export function shouldAutoEnable(model: DiscoveredModel): boolean {
  return model.capabilities.some((capability) => {
    const normalized = capability.trim().toLowerCase();
    return normalized === "text" || normalized === "code";
  });
}

export async function findModelCatalogRemovalBlockers(
  sql: SqlExecutor,
  catalogId: string,
): Promise<string[]> {
  const [catalog] = await sql<CatalogRow[]>`
    SELECT id, provider, adapter_type, model_id
    FROM model_catalog
    WHERE id = ${catalogId}
  `;

  if (!catalog) return [];

  const blockers: string[] = [];
  const [hiveModels] = await sql<CountRow[]>`
    SELECT COUNT(*)::text AS count
    FROM hive_models
    WHERE model_catalog_id = ${catalog.id}
  `;
  if (Number(hiveModels?.count ?? 0) > 0) {
    blockers.push("hive_models");
  }

  const roleTemplates = await sql<RoleModelReferenceRow[]>`
    SELECT adapter_type, recommended_model, fallback_adapter_type, fallback_model
    FROM role_templates
    WHERE (adapter_type = ${catalog.adapter_type} AND recommended_model IS NOT NULL)
       OR (COALESCE(fallback_adapter_type, adapter_type) = ${catalog.adapter_type}
        AND fallback_model IS NOT NULL)
  `;
  const hasRoleTemplateBlocker = roleTemplates.some((role) => {
    const recommendedModel = role.recommended_model
      ? canonicalModelIdForAdapter(role.adapter_type, role.recommended_model)
      : null;
    const fallbackAdapterType = role.fallback_adapter_type ?? role.adapter_type;
    const fallbackModel = role.fallback_model
      ? canonicalModelIdForAdapter(fallbackAdapterType, role.fallback_model)
      : null;

    return recommendedModel === catalog.model_id || fallbackModel === catalog.model_id;
  });
  if (hasRoleTemplateBlocker) {
    blockers.push("role_templates");
  }

  const taskRows = await sql<TaskModelReferenceRow[]>`
    SELECT
      t.adapter_override,
      t.adapter_used,
      t.status,
      rt.adapter_type AS role_adapter_type,
      rt.fallback_adapter_type AS role_fallback_adapter_type,
      t.model_override,
      t.model_used
    FROM tasks t
    LEFT JOIN role_templates rt ON rt.slug = t.assigned_to
    WHERE t.model_override IS NOT NULL
       OR t.model_used IS NOT NULL
  `;
  const hasTaskBlocker = taskRows.some((task) => {
    const overrideAdapter = task.adapter_override ?? task.role_adapter_type;
    const overrideModel = task.model_override
      ? overrideAdapter
        ? canonicalModelIdForAdapter(overrideAdapter, task.model_override)
        : null
      : null;
    const usedModelMatches = task.model_used
      ? candidateAdaptersForUsedModel(task, catalog.adapter_type).some((adapterType) =>
          canonicalModelIdForAdapter(adapterType, task.model_used as string) === catalog.model_id,
        )
      : false;
    return overrideModel === catalog.model_id || usedModelMatches;
  });
  if (hasTaskBlocker) {
    blockers.push("tasks");
  }

  const policyRows = await sql<AdapterConfigRow[]>`
    SELECT config
    FROM adapter_config
    WHERE adapter_type = ${MODEL_ROUTING_ADAPTER_CONFIG_TYPE}
  `;
  const hasPolicyBlocker = policyRows.some((row) =>
    modelRoutingConfigReferencesCatalog(row.config, catalog),
  );
  if (hasPolicyBlocker) {
    blockers.push("model_routing_policy");
  }

  return blockers;
}

export async function lockModelCatalogRemovalBlockerTables(sql: SqlExecutor): Promise<void> {
  await setModelCatalogCleanupLockTimeout(sql);
  await sql`
    LOCK TABLE hive_models, role_templates, tasks, adapter_config IN SHARE MODE
  `;
}

export async function setModelCatalogCleanupLockTimeout(sql: SqlExecutor): Promise<void> {
  await sql`
    SELECT set_config('lock_timeout', ${"2s"}, true)
  `;
}

function candidateAdaptersForUsedModel(task: TaskModelReferenceRow, catalogAdapterType: string): string[] {
  const adapters = new Set<string>();
  if (task.adapter_used) {
    adapters.add(task.adapter_used);
    return [...adapters];
  }

  if (task.adapter_override) adapters.add(task.adapter_override);
  if (task.role_adapter_type) adapters.add(task.role_adapter_type);
  if (task.role_fallback_adapter_type) adapters.add(task.role_fallback_adapter_type);
  if (isTerminalTaskStatus(task.status)) adapters.add(catalogAdapterType);
  return [...adapters];
}

function isTerminalTaskStatus(status: string): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "blocked" ||
    status === "unresolvable";
}

function modelRoutingConfigReferencesCatalog(config: unknown, catalog: CatalogRow): boolean {
  if (!config || typeof config !== "object") return false;
  const source = config as Record<string, unknown>;
  const routeKey = routeKeyForModel({
    provider: catalog.provider,
    adapterType: catalog.adapter_type,
    model: catalog.model_id,
  });

  const routeOverrides = source.routeOverrides;
  if (
    routeOverrides &&
    typeof routeOverrides === "object" &&
    Object.prototype.hasOwnProperty.call(routeOverrides, routeKey)
  ) {
    return true;
  }

  if (Array.isArray(source.candidates)) {
    const hasCandidate = source.candidates.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const item = candidate as Record<string, unknown>;
      const adapterType = typeof item.adapterType === "string" ? item.adapterType.trim() : "";
      const model = typeof item.model === "string" ? item.model.trim() : "";
      if (adapterType !== catalog.adapter_type || !model) return false;
      return canonicalModelIdForAdapter(adapterType, model) === catalog.model_id;
    });
    if (hasCandidate) return true;
  }

  const roleRoutes = source.roleRoutes;
  if (!roleRoutes || typeof roleRoutes !== "object") return false;
  return Object.values(roleRoutes as Record<string, unknown>).some((rawRoute) => {
    if (!rawRoute || typeof rawRoute !== "object") return false;
    const candidateModels = (rawRoute as Record<string, unknown>).candidateModels;
    if (!Array.isArray(candidateModels)) return false;
    return candidateModels.some((model) =>
      typeof model === "string" &&
      canonicalModelIdForAdapter(catalog.adapter_type, model) === catalog.model_id,
    );
  });
}

function normalizeModel(model: DiscoveredModel): NormalizedDiscoveredModel {
  const adapterType = model.adapterType.trim();

  return {
    ...model,
    provider: model.provider.trim().toLowerCase(),
    adapterType,
    modelId: canonicalModelIdForAdapter(adapterType, model.modelId),
    displayName: model.displayName.trim(),
    family: model.family?.trim() || null,
    capabilities: model.capabilities.map((capability) => capability.trim()).filter(Boolean),
    costPerInputToken: model.costPerInputToken ?? null,
    costPerOutputToken: model.costPerOutputToken ?? null,
    benchmarkQualityScore: model.benchmarkQualityScore ?? null,
    routingCostScore: model.routingCostScore ?? null,
    metadataSourceName: model.metadataSourceName ?? null,
    metadataSourceUrl: model.metadataSourceUrl ?? null,
  };
}

async function upsertModelCatalog(
  sql: SqlExecutor,
  model: NormalizedDiscoveredModel,
  context: {
    source: string;
    runId: string;
  },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
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
      discovery_source,
      first_seen_at,
      last_seen_at,
      last_discovery_run_id,
      stale_since,
      updated_at
    )
    VALUES (
      ${model.provider},
      ${model.adapterType},
      ${model.modelId},
      ${model.displayName},
      ${model.family},
      ${sql.json(model.capabilities)},
      ${model.local},
      ${model.costPerInputToken},
      ${model.costPerOutputToken},
      ${model.benchmarkQualityScore},
      ${model.routingCostScore},
      ${model.metadataSourceName},
      ${model.metadataSourceUrl},
      NOW(),
      ${context.source},
      NOW(),
      NOW(),
      ${context.runId},
      NULL,
      NOW()
    )
    ON CONFLICT (provider, adapter_type, model_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          family = COALESCE(EXCLUDED.family, model_catalog.family),
          capabilities = EXCLUDED.capabilities,
          local = EXCLUDED.local,
          cost_per_input_token = COALESCE(EXCLUDED.cost_per_input_token, model_catalog.cost_per_input_token),
          cost_per_output_token = COALESCE(EXCLUDED.cost_per_output_token, model_catalog.cost_per_output_token),
          benchmark_quality_score = COALESCE(EXCLUDED.benchmark_quality_score, model_catalog.benchmark_quality_score),
          routing_cost_score = COALESCE(EXCLUDED.routing_cost_score, model_catalog.routing_cost_score),
          metadata_source_name = COALESCE(EXCLUDED.metadata_source_name, model_catalog.metadata_source_name),
          metadata_source_url = COALESCE(EXCLUDED.metadata_source_url, model_catalog.metadata_source_url),
          metadata_last_checked_at = NOW(),
          discovery_source = EXCLUDED.discovery_source,
          first_seen_at = COALESCE(model_catalog.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = NOW(),
          last_discovery_run_id = EXCLUDED.last_discovery_run_id,
          stale_since = NULL,
          updated_at = NOW()
    RETURNING id
  `;

  if (!row) throw new Error("model catalog upsert did not return a row");
  return row.id;
}

async function upsertHiveModel(
  sql: SqlExecutor,
  model: NormalizedDiscoveredModel,
  context: {
    hiveId: string;
    credentialId: string | null;
    catalogId: string;
    runId: string;
  },
): Promise<HiveModelUpsertRow> {
  const enabled = shouldAutoEnable(model);
  const [row] = await sql<HiveModelUpsertRow[]>`
    WITH existing AS (
      SELECT id, enabled
      FROM hive_models
      WHERE hive_id = ${context.hiveId}
        AND provider = ${model.provider}
        AND model_id = ${model.modelId}
    ),
    upserted AS (
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        model_catalog_id,
        credential_id,
        capabilities,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score,
        enabled,
        auto_discovered,
        last_discovery_run_id,
        last_seen_at,
        updated_at
      )
      VALUES (
        ${context.hiveId},
        ${model.provider},
        ${model.adapterType},
        ${model.modelId},
        ${context.catalogId},
        ${context.credentialId},
        ${sql.json(model.capabilities)},
        ${model.costPerInputToken},
        ${model.costPerOutputToken},
        ${model.benchmarkQualityScore},
        ${model.routingCostScore},
        ${enabled},
        true,
        ${context.runId},
        NOW(),
        NOW()
      )
      ON CONFLICT (hive_id, provider, model_id) DO UPDATE
        SET adapter_type = EXCLUDED.adapter_type,
            model_catalog_id = EXCLUDED.model_catalog_id,
            credential_id = COALESCE(EXCLUDED.credential_id, hive_models.credential_id),
            capabilities = EXCLUDED.capabilities,
            cost_per_input_token = COALESCE(EXCLUDED.cost_per_input_token, hive_models.cost_per_input_token),
            cost_per_output_token = COALESCE(EXCLUDED.cost_per_output_token, hive_models.cost_per_output_token),
            benchmark_quality_score = COALESCE(EXCLUDED.benchmark_quality_score, hive_models.benchmark_quality_score),
            routing_cost_score = COALESCE(EXCLUDED.routing_cost_score, hive_models.routing_cost_score),
            enabled = CASE
              WHEN hive_models.owner_disabled_at IS NOT NULL THEN false
              ELSE EXCLUDED.enabled
            END,
            auto_discovered = true,
            last_discovery_run_id = EXCLUDED.last_discovery_run_id,
            last_seen_at = NOW(),
            updated_at = NOW()
      RETURNING id, enabled, owner_disabled_at
    )
    SELECT upserted.id,
           upserted.enabled,
           upserted.owner_disabled_at,
           existing.id IS NULL AS inserted,
           existing.enabled AS previous_enabled
    FROM upserted
    LEFT JOIN existing ON true
  `;

  if (!row) throw new Error("hive model upsert did not return a row");
  return row;
}

async function markMissingModelsStale(
  sql: SqlExecutor,
  input: {
    provider: string;
    adapterType: string;
    source: string;
    runId: string;
    modelIds: string[];
  },
): Promise<number> {
  const rows = input.modelIds.length
    ? await sql<CountRow[]>`
        UPDATE model_catalog
        SET stale_since = NOW(),
            updated_at = NOW()
        WHERE provider = ${input.provider}
          AND adapter_type = ${input.adapterType}
          AND discovery_source = ${input.source}
          AND last_discovery_run_id IS DISTINCT FROM ${input.runId}
          AND stale_since IS NULL
          AND model_id <> ALL(${input.modelIds}::text[])
        RETURNING 1::text AS count
      `
    : await sql<CountRow[]>`
        UPDATE model_catalog
        SET stale_since = NOW(),
            updated_at = NOW()
        WHERE provider = ${input.provider}
          AND adapter_type = ${input.adapterType}
          AND discovery_source = ${input.source}
          AND last_discovery_run_id IS DISTINCT FROM ${input.runId}
          AND stale_since IS NULL
        RETURNING 1::text AS count
      `;

  return rows.length;
}
