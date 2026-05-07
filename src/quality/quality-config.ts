import type { Sql } from "postgres";

export const QUALITY_CONTROLS_ADAPTER_TYPE = "quality-controls";

export const DEFAULT_QUALITY_CONTROLS_CONFIG = {
  default_quality_floor: 0.7,
  role_quality_floors: {} as Record<string, number>,
};

export interface QualityControlsConfig {
  defaultQualityFloor: number;
  roleQualityFloors: Record<string, number>;
}

export async function loadQualityControlsConfig(
  sql: Sql,
  hiveId?: string | null,
): Promise<QualityControlsConfig> {
  const rows = hiveId
    ? await sql<{ config: Record<string, unknown>; hive_id: string | null }[]>`
        SELECT config, hive_id
        FROM adapter_config
        WHERE adapter_type = ${QUALITY_CONTROLS_ADAPTER_TYPE}
          AND (hive_id = ${hiveId}::uuid OR hive_id IS NULL)
        ORDER BY hive_id NULLS LAST
        LIMIT 1
      `
    : await sql<{ config: Record<string, unknown>; hive_id: string | null }[]>`
        SELECT config, hive_id
        FROM adapter_config
        WHERE adapter_type = ${QUALITY_CONTROLS_ADAPTER_TYPE}
          AND hive_id IS NULL
        LIMIT 1
      `;

  const config = rows[0]?.config ?? {};
  return normaliseQualityControlsConfig(config);
}

export function normaliseQualityControlsConfig(config: Record<string, unknown>): QualityControlsConfig {
  const roleFloors = typeof config.role_quality_floors === "object" && config.role_quality_floors !== null
    ? Object.fromEntries(
        Object.entries(config.role_quality_floors as Record<string, unknown>)
          .map(([role, value]) => [role, asFloor(value, NaN)] as const)
          .filter(([, value]) => Number.isFinite(value)),
      )
    : {};

  return {
    defaultQualityFloor: asFloor(
      config.default_quality_floor,
      DEFAULT_QUALITY_CONTROLS_CONFIG.default_quality_floor,
    ),
    roleQualityFloors: roleFloors,
  };
}

export function applicableQualityFloor(
  config: QualityControlsConfig,
  roleSlug: string,
): number {
  return config.roleQualityFloors[roleSlug] ?? config.defaultQualityFloor;
}

function asFloor(value: unknown, fallback: number): number {
  const n = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}
