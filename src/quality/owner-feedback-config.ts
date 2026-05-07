import type { Sql } from "postgres";

export const OWNER_FEEDBACK_ADAPTER_TYPE = "owner-feedback-sampling";

export const DEFAULT_OWNER_FEEDBACK_CONFIG = {
  owner_feedback_sample_rate: 0.08,
  ai_peer_feedback_sample_rate: 0.5,
  owner_feedback_eligibility_window_days: 7,
  owner_feedback_duplicate_cooldown_days: 30,
  owner_feedback_per_role_daily_cap: 2,
  owner_feedback_per_day_cap: 5,
};

export interface OwnerFeedbackSamplingConfig {
  sampleRate: number;
  aiPeerReviewSampleRate: number;
  eligibilityWindowDays: number;
  duplicateCooldownDays: number;
  perRoleDailyCap: number;
  perDayCap: number;
}

export interface OwnerFeedbackSamplingPatch {
  ownerFeedbackSampleRate: number;
  aiPeerFeedbackSampleRate: number;
}

export interface OwnerFeedbackSamplingConfigRow {
  id: string;
  hiveId: string | null;
  adapterType: string;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export async function loadOwnerFeedbackSamplingConfig(
  sql: Sql,
  hiveId: string,
): Promise<OwnerFeedbackSamplingConfig> {
  const { effectiveConfig } = await loadOwnerFeedbackSamplingConfigState(sql, hiveId);
  return effectiveConfig;
}

export async function loadOwnerFeedbackSamplingConfigState(
  sql: Sql,
  hiveId: string,
): Promise<{
  effectiveConfig: OwnerFeedbackSamplingConfig;
  rawRow: OwnerFeedbackSamplingConfigRow | null;
  source: "hive" | "global" | "default";
}> {
  const rows = await sql<{
    id: string;
    hive_id: string | null;
    adapter_type: string;
    config: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }[]>`
    SELECT id, hive_id, adapter_type, config, created_at, updated_at
    FROM adapter_config
    WHERE adapter_type = ${OWNER_FEEDBACK_ADAPTER_TYPE}
      AND (hive_id = ${hiveId}::uuid OR hive_id IS NULL)
    ORDER BY hive_id NULLS FIRST, updated_at ASC, created_at ASC
  `;

  const config = rows.reduce<Record<string, unknown>>(
    (merged, row) => ({ ...merged, ...row.config }),
    {},
  );
  const raw = lastWhere(rows, (row) => row.hive_id === hiveId) ?? rows[0] ?? null;
  const source = raw?.hive_id === hiveId ? "hive" : raw ? "global" : "default";

  return {
    effectiveConfig: parseOwnerFeedbackSamplingConfig(config),
    rawRow: raw
      ? {
          id: raw.id,
          hiveId: raw.hive_id,
          adapterType: raw.adapter_type,
          config: raw.config,
          createdAt: raw.created_at,
          updatedAt: raw.updated_at,
        }
      : null,
    source,
  };
}

export async function loadOwnerFeedbackSamplingConfigRow(
  sql: Sql,
  hiveId: string,
): Promise<OwnerFeedbackSamplingConfigRow | null> {
  const [row] = await sql<{
    id: string;
    hive_id: string | null;
    adapter_type: string;
    config: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }[]>`
    SELECT id, hive_id, adapter_type, config, created_at, updated_at
    FROM adapter_config
    WHERE adapter_type = ${OWNER_FEEDBACK_ADAPTER_TYPE}
      AND hive_id = ${hiveId}::uuid
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `;

  return row
    ? {
        id: row.id,
        hiveId: row.hive_id,
        adapterType: row.adapter_type,
        config: row.config,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export function validateOwnerFeedbackSamplingPatch(
  input: Record<string, unknown>,
): OwnerFeedbackSamplingPatch | { error: string } {
  const ownerFeedbackSampleRate = asNumber(
    input.ownerFeedbackSampleRate ?? input.owner_feedback_sample_rate,
  );
  const aiPeerFeedbackSampleRate = asNumber(
    input.aiPeerFeedbackSampleRate ?? input.ai_peer_feedback_sample_rate,
  );

  if (!isValidRate(ownerFeedbackSampleRate) || !isValidRate(aiPeerFeedbackSampleRate)) {
    return {
      error: "ownerFeedbackSampleRate and aiPeerFeedbackSampleRate must be numbers from 0 to 1",
    };
  }

  return { ownerFeedbackSampleRate, aiPeerFeedbackSampleRate };
}

export async function saveOwnerFeedbackSamplingConfig(
  sql: Sql,
  hiveId: string,
  patch: OwnerFeedbackSamplingPatch,
): Promise<string> {
  const current = await loadOwnerFeedbackSamplingConfigState(sql, hiveId);
  const configPatch = {
    owner_feedback_sample_rate: patch.ownerFeedbackSampleRate,
    ai_peer_feedback_sample_rate: patch.aiPeerFeedbackSampleRate,
  };
  const existing = await loadOwnerFeedbackSamplingConfigRow(sql, hiveId);

  if (existing) {
    await sql`
      UPDATE adapter_config
      SET config = ${sql.json({ ...existing.config, ...configPatch })},
          updated_at = NOW()
      WHERE id = ${existing.id}
    `;
    return existing.id;
  }

  const effectiveConfig = {
    owner_feedback_sample_rate: current.effectiveConfig.sampleRate,
    ai_peer_feedback_sample_rate: current.effectiveConfig.aiPeerReviewSampleRate,
    owner_feedback_eligibility_window_days: current.effectiveConfig.eligibilityWindowDays,
    owner_feedback_duplicate_cooldown_days: current.effectiveConfig.duplicateCooldownDays,
    owner_feedback_per_role_daily_cap: current.effectiveConfig.perRoleDailyCap,
    owner_feedback_per_day_cap: current.effectiveConfig.perDayCap,
  };

  const [inserted] = await sql<{ id: string }[]>`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (
      ${hiveId}::uuid,
      ${OWNER_FEEDBACK_ADAPTER_TYPE},
      ${sql.json({ ...effectiveConfig, ...configPatch })}
    )
    RETURNING id
  `;
  return inserted.id;
}

export function parseOwnerFeedbackSamplingConfig(
  config: Record<string, unknown>,
): OwnerFeedbackSamplingConfig {
  return {
    sampleRate: asRate(
      config.owner_feedback_sample_rate,
      DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_sample_rate,
    ),
    aiPeerReviewSampleRate: asRate(
      config.ai_peer_feedback_sample_rate,
      DEFAULT_OWNER_FEEDBACK_CONFIG.ai_peer_feedback_sample_rate,
    ),
    eligibilityWindowDays: asPositiveInteger(
      config.owner_feedback_eligibility_window_days,
      DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_eligibility_window_days,
    ),
    duplicateCooldownDays: asPositiveInteger(
      config.owner_feedback_duplicate_cooldown_days,
      DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_duplicate_cooldown_days,
    ),
    perRoleDailyCap: asPositiveInteger(
      config.owner_feedback_per_role_daily_cap,
      DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_per_role_daily_cap,
    ),
    perDayCap: asPositiveInteger(
      config.owner_feedback_per_day_cap,
      DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_per_day_cap,
    ),
  };
}

export async function loadLegacyOwnerFeedbackSamplingConfig(
  sql: Sql,
  hiveId: string,
): Promise<OwnerFeedbackSamplingConfig> {
  const rows = await sql<{ config: Record<string, unknown> }[]>`
    SELECT config, hive_id
    FROM adapter_config
    WHERE adapter_type = ${OWNER_FEEDBACK_ADAPTER_TYPE}
      AND (hive_id = ${hiveId}::uuid OR hive_id IS NULL)
    ORDER BY hive_id NULLS LAST
    LIMIT 1
  `;

  return parseOwnerFeedbackSamplingConfig(rows[0]?.config ?? {});
}

function asRate(value: unknown, fallback: number): number {
  const n = asNumber(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

function isValidRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function lastWhere<T>(items: T[], predicate: (item: T) => boolean): T | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) return items[i];
  }
  return null;
}

function asPositiveInteger(value: unknown, fallback: number): number {
  const n = asNumber(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function asNumber(value: unknown): number {
  return typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : NaN;
}
