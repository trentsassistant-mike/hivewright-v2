import type { Sql } from "postgres";
import { upsertModelCatalogEntry } from "@/model-catalog/catalog";
import { AUTO_MODEL_ROUTE } from "@/model-routing/selector";
import { canonicalModelIdForAdapter } from "./model-identity";

export interface SyncConfiguredHiveModelsInput {
  hiveId: string;
}

export interface SyncConfiguredHiveModelsResult {
  considered: number;
  upserted: number;
  skipped: number;
  sources: {
    rolePrimary: number;
    roleFallback: number;
    routingCandidate: number;
  };
}

type CandidateSource = "role-primary" | "role-fallback" | "routing-candidate";

interface ModelRegistryCandidate {
  adapterType: string;
  modelId: string;
  source: CandidateSource;
  fallbackPriority: number;
}

interface RoleModelRow {
  adapter_type: string | null;
  recommended_model: string | null;
  fallback_adapter_type: string | null;
  fallback_model: string | null;
}

export async function syncConfiguredHiveModels(
  sql: Sql,
  input: SyncConfiguredHiveModelsInput,
): Promise<SyncConfiguredHiveModelsResult> {
  const rawCandidates = await roleModelCandidates(sql);
  const deduped = dedupeCandidates(rawCandidates);
  const result: SyncConfiguredHiveModelsResult = {
    considered: deduped.length,
    upserted: 0,
    skipped: 0,
    sources: {
      rolePrimary: 0,
      roleFallback: 0,
      routingCandidate: 0,
    },
  };

  for (const candidate of deduped) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) {
      result.skipped += 1;
      continue;
    }
    const modelCatalogId = await upsertModelCatalogEntry(sql, {
      provider: normalized.provider,
      adapterType: normalized.adapterType,
      modelId: normalized.modelId,
      displayName: displayNameForModel(normalized.modelId),
      family: familyForModel(normalized.modelId),
      capabilities: ["text", "code"],
      local: normalized.provider === "local" || normalized.adapterType === "ollama",
      costPerInputToken: null,
      costPerOutputToken: null,
      benchmarkQualityScore: null,
      routingCostScore: null,
      metadataSourceName: "Role template model configuration",
      metadataSourceUrl: null,
    });

    await sql`
      INSERT INTO hive_models (
        hive_id,
        model_catalog_id,
        provider,
        model_id,
        adapter_type,
        fallback_priority,
        enabled,
        updated_at
      )
      VALUES (
        ${input.hiveId},
        ${modelCatalogId},
        ${normalized.provider},
        ${normalized.modelId},
        ${normalized.adapterType},
        ${normalized.fallbackPriority},
        true,
        NOW()
      )
      ON CONFLICT (hive_id, provider, model_id) DO UPDATE
        SET model_catalog_id = EXCLUDED.model_catalog_id,
            adapter_type = EXCLUDED.adapter_type,
            fallback_priority = LEAST(hive_models.fallback_priority, EXCLUDED.fallback_priority),
            enabled = true,
            updated_at = NOW()
    `;
    result.upserted += 1;
    incrementSource(result, candidate.source);
  }

  return result;
}

function displayNameForModel(modelId: string): string {
  const suffix = modelId.includes("/") ? modelId.split("/").at(-1) : modelId;
  return (suffix ?? modelId)
    .split(/[-_:]/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function familyForModel(modelId: string): string | null {
  const model = modelId.toLowerCase();
  if (model.includes("gpt-5")) return "gpt-5";
  if (model.includes("claude-opus")) return "claude-opus";
  if (model.includes("claude-sonnet")) return "claude-sonnet";
  if (model.includes("gemini")) return "gemini";
  if (model.includes("qwen")) return "qwen";
  return null;
}

async function roleModelCandidates(sql: Sql): Promise<ModelRegistryCandidate[]> {
  const roles = await sql<RoleModelRow[]>`
    SELECT
      adapter_type,
      recommended_model,
      fallback_adapter_type,
      fallback_model
    FROM role_templates
    WHERE active = true
    ORDER BY slug ASC
  `;
  return roles.flatMap((role) => {
    const candidates: ModelRegistryCandidate[] = [
      {
        adapterType: role.adapter_type ?? "",
        modelId: role.recommended_model ?? "",
        source: "role-primary",
        fallbackPriority: 100,
      },
    ];
    if (role.fallback_model) {
      candidates.push({
        adapterType: role.fallback_adapter_type ?? role.adapter_type ?? "",
        modelId: role.fallback_model,
        source: "role-fallback",
        fallbackPriority: 200,
      });
    }
    return candidates;
  });
}

function dedupeCandidates(candidates: ModelRegistryCandidate[]): ModelRegistryCandidate[] {
  const byKey = new Map<string, ModelRegistryCandidate>();
  for (const candidate of candidates) {
    const adapterType = candidate.adapterType.trim();
    const modelId = canonicalModelIdForAdapter(adapterType, candidate.modelId.trim());
    const key = `${adapterType.toLowerCase()}:${modelId.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, { ...candidate, adapterType, modelId });
  }
  return [...byKey.values()];
}

function normalizeCandidate(candidate: ModelRegistryCandidate): null | {
  provider: string;
  adapterType: string;
  modelId: string;
  fallbackPriority: number;
} {
  const adapterType = candidate.adapterType.trim();
  const modelId = canonicalModelIdForAdapter(adapterType, candidate.modelId.trim());
  if (!adapterType || !modelId) return null;
  if (adapterType === AUTO_MODEL_ROUTE || modelId === AUTO_MODEL_ROUTE) return null;
  if (isUnsupportedModelHealthCandidate(adapterType, modelId)) return null;

  return {
    provider: inferProvider(adapterType, modelId),
    adapterType,
    modelId,
    fallbackPriority: candidate.fallbackPriority,
  };
}

function isUnsupportedModelHealthCandidate(adapterType: string, modelId: string): boolean {
  const adapter = adapterType.toLowerCase();
  const model = modelId.toLowerCase();

  if (adapter === "openai-image") return true;
  if (model === "gpt-image-2" || model === "gpt-image-2-2026-04-21") return true;
  if (model === "google/gemini-3.1-flash-live-preview" || model === "gemini-3.1-flash-live-preview") {
    return true;
  }

  return false;
}

export function inferProvider(adapterType: string, modelId: string): string {
  const adapter = adapterType.trim().toLowerCase();
  const model = modelId.trim().toLowerCase();
  const prefix = model.includes("/") ? model.split("/", 1)[0] : "";

  if (adapter === "ollama") return "local";
  if (adapter === "openai-image") return "openai";
  if (adapter === "claude-code") return "anthropic";
  if (adapter === "gemini") return "google";
  if (adapter === "codex") return "openai";

  if (prefix === "openai" || prefix === "openai-codex") return "openai";
  if (prefix === "anthropic") return "anthropic";
  if (prefix === "google") return "google";
  if (prefix) return prefix;
  if (model.startsWith("gpt-")) return "openai";

  return adapter || "unknown";
}

function incrementSource(
  result: SyncConfiguredHiveModelsResult,
  source: CandidateSource,
) {
  switch (source) {
    case "role-primary":
      result.sources.rolePrimary += 1;
      break;
    case "role-fallback":
      result.sources.roleFallback += 1;
      break;
    case "routing-candidate":
      result.sources.routingCandidate += 1;
      break;
  }
}
