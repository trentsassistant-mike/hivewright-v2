import type { Sql } from "postgres";
import { DEFAULT_WORK_INTAKE_CONFIG, type WorkIntakeConfig } from "./types";
import type { ProviderId } from "@/llm/types";

export async function loadWorkIntakeConfig(sql: Sql): Promise<WorkIntakeConfig> {
  const rows = await sql<{ config: Record<string, unknown> }[]>`
    SELECT config FROM adapter_config
    WHERE adapter_type = 'work-intake' AND hive_id IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return { ...DEFAULT_WORK_INTAKE_CONFIG };

  const c = rows[0].config;
  return {
    primaryProvider: asProvider(c.primaryProvider, DEFAULT_WORK_INTAKE_CONFIG.primaryProvider),
    primaryModel: asString(c.primaryModel, DEFAULT_WORK_INTAKE_CONFIG.primaryModel),
    fallbackProvider: asProvider(c.fallbackProvider, DEFAULT_WORK_INTAKE_CONFIG.fallbackProvider),
    fallbackModel: asString(c.fallbackModel, DEFAULT_WORK_INTAKE_CONFIG.fallbackModel),
    confidenceThreshold: asNumber(c.confidenceThreshold, DEFAULT_WORK_INTAKE_CONFIG.confidenceThreshold),
    timeoutMs: asNumber(c.timeoutMs, DEFAULT_WORK_INTAKE_CONFIG.timeoutMs),
    temperature: asNumber(c.temperature, DEFAULT_WORK_INTAKE_CONFIG.temperature),
    maxTokens: asNumber(c.maxTokens, DEFAULT_WORK_INTAKE_CONFIG.maxTokens),
  };
}

function asProvider(v: unknown, fallback: ProviderId): ProviderId {
  return v === "ollama" || v === "openrouter" || v === "none" ? v : fallback;
}
function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
