import type { Sql } from "postgres";

export const MODEL_EFFICIENCY_ADAPTER_TYPE = "model-efficiency";

export const DEFAULT_MODEL_EFFICIENCY_CONFIG = {
  efficiency_avg_cost_cents_threshold: 50,
  efficiency_min_completions_threshold: 5,
};

export interface ModelEfficiencyConfig {
  avgCostCentsThreshold: number;
  minCompletionsThreshold: number;
}

export async function loadModelEfficiencyConfig(
  sql: Sql,
): Promise<ModelEfficiencyConfig> {
  const rows = await sql<{ config: Record<string, unknown> }[]>`
    SELECT config FROM adapter_config
    WHERE adapter_type = ${MODEL_EFFICIENCY_ADAPTER_TYPE} AND hive_id IS NULL
    LIMIT 1
  `;

  const config = rows[0]?.config ?? {};
  return {
    avgCostCentsThreshold: asPositiveInteger(
      config.efficiency_avg_cost_cents_threshold,
      DEFAULT_MODEL_EFFICIENCY_CONFIG.efficiency_avg_cost_cents_threshold,
    ),
    minCompletionsThreshold: asPositiveInteger(
      config.efficiency_min_completions_threshold,
      DEFAULT_MODEL_EFFICIENCY_CONFIG.efficiency_min_completions_threshold,
    ),
  };
}

function asPositiveInteger(value: unknown, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}
