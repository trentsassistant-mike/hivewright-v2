import type { Sql } from "postgres";
import type { ModelRoutingPolicy } from "./selector";

export const MODEL_ROUTING_ADAPTER_CONFIG_TYPE = "model-routing";

export interface ModelRoutingPolicyState {
  policy: ModelRoutingPolicy | null;
  source: "hive" | "global" | "none";
  rawRow: { id: string; hiveId: string | null; config: unknown } | null;
}

export async function loadModelRoutingPolicy(
  sql: Sql,
  hiveId: string,
): Promise<ModelRoutingPolicy | null> {
  const state = await loadModelRoutingPolicyState(sql, hiveId);
  return state.policy;
}

export async function loadModelRoutingPolicyState(
  sql: Sql,
  hiveId: string,
): Promise<ModelRoutingPolicyState> {
  const [row] = await sql<{ id: string; hive_id: string | null; config: unknown }[]>`
    SELECT id, hive_id, config
    FROM adapter_config
    WHERE adapter_type = ${MODEL_ROUTING_ADAPTER_CONFIG_TYPE}
      AND (hive_id = ${hiveId} OR hive_id IS NULL)
    ORDER BY hive_id NULLS LAST, updated_at DESC
    LIMIT 1
  `;

  if (!row?.config || typeof row.config !== "object") {
    return { policy: null, source: "none", rawRow: null };
  }

  const hiveIdValue = typeof row.hive_id === "string" ? row.hive_id : null;
  return {
    policy: normalizeModelRoutingPolicy(row.config),
    source: hiveIdValue === hiveId ? "hive" : "global",
    rawRow: {
      id: String(row.id),
      hiveId: hiveIdValue,
      config: row.config,
    },
  };
}

export async function saveModelRoutingPolicy(
  sql: Sql,
  hiveId: string,
  policy: ModelRoutingPolicy,
): Promise<string> {
  const jsonPolicy = policy as unknown as Parameters<typeof sql.json>[0];
  const [existing] = await sql<{ id: string }[]>`
    SELECT id
    FROM adapter_config
    WHERE adapter_type = ${MODEL_ROUTING_ADAPTER_CONFIG_TYPE}
      AND hive_id = ${hiveId}
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  if (existing?.id) {
    await sql`
      UPDATE adapter_config
      SET config = ${sql.json(jsonPolicy)},
          updated_at = NOW()
      WHERE id = ${existing.id}
    `;
    return existing.id;
  }

  const [inserted] = await sql<{ id: string }[]>`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (${hiveId}, ${MODEL_ROUTING_ADAPTER_CONFIG_TYPE}, ${sql.json(jsonPolicy)})
    RETURNING id
  `;
  return inserted.id;
}

export function normalizeModelRoutingPolicy(value: unknown): ModelRoutingPolicy | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const candidates = Array.isArray(source.candidates)
    ? source.candidates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const item = candidate as Record<string, unknown>;
        const adapterType = typeof item.adapterType === "string" ? item.adapterType.trim() : "";
        const model = typeof item.model === "string" ? item.model.trim() : "";
        if (!adapterType || !model) return [];
        return [{
          adapterType,
          model,
          enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
          status: asCandidateStatus(item.status),
          qualityScore: asNumber(item.qualityScore),
          costScore: asNumber(item.costScore),
          local: typeof item.local === "boolean" ? item.local : undefined,
          roleSlugs: asStringArray(item.roleSlugs),
          roleTypes: asStringArray(item.roleTypes),
        }];
      })
    : [];

  return {
    preferences: normalizePreferences(source.preferences),
    routeOverrides: normalizeRouteOverrides(source.routeOverrides),
    roleRoutes: normalizeRoleRoutes(source.roleRoutes),
    candidates,
  };
}

function normalizePreferences(value: unknown): ModelRoutingPolicy["preferences"] {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const explicitBalance = asNumber(source.costQualityBalance);
  if (explicitBalance !== undefined) {
    return { costQualityBalance: clampRoutingBalance(explicitBalance) };
  }
  if (Object.hasOwn(source, "costQualityBalance")) {
    return { costQualityBalance: 50 };
  }

  const qualityWeight = asNumber(source.qualityWeight);
  const costWeight = asNumber(source.costWeight);
  if (
    qualityWeight !== undefined &&
    costWeight !== undefined &&
    qualityWeight >= 0 &&
    costWeight >= 0 &&
    qualityWeight + costWeight > 0
  ) {
    return {
      costQualityBalance: clampRoutingBalance((qualityWeight / (qualityWeight + costWeight)) * 100),
    };
  }

  return { costQualityBalance: 50 };
}

function clampRoutingBalance(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeRoleRoutes(value: unknown): ModelRoutingPolicy["roleRoutes"] {
  if (!value || typeof value !== "object") return undefined;
  const out: NonNullable<ModelRoutingPolicy["roleRoutes"]> = {};
  for (const [roleSlug, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const candidateModels = asStringArray((raw as Record<string, unknown>).candidateModels);
    if (candidateModels) out[roleSlug] = { candidateModels };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRouteOverrides(value: unknown): ModelRoutingPolicy["routeOverrides"] {
  if (!value || typeof value !== "object") return undefined;
  const out: NonNullable<ModelRoutingPolicy["routeOverrides"]> = {};

  for (const [routeKey, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = routeKey.trim();
    if (!key || !raw || typeof raw !== "object") continue;
    const source = raw as Record<string, unknown>;
    const override: NonNullable<ModelRoutingPolicy["routeOverrides"]>[string] = {};
    if (typeof source.enabled === "boolean") override.enabled = source.enabled;
    const roleSlugs = asStringArray(source.roleSlugs);
    if (roleSlugs) override.roleSlugs = roleSlugs;
    if (Object.keys(override).length > 0) out[key] = override;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function asCandidateStatus(value: unknown): "healthy" | "unknown" | "unhealthy" | "degraded" | "disabled" | undefined {
  return value === "healthy" ||
    value === "unknown" ||
    value === "unhealthy" ||
    value === "degraded" ||
    value === "disabled"
    ? value
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}
