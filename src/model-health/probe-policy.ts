import { getAdapterCapabilities } from "@/adapters/capabilities";

const CHEAP_HEALTHY_TTL_MS = 60 * 60 * 1000;
const CHEAP_UNHEALTHY_RETRY_MS = 15 * 60 * 1000;
const STANDARD_HEALTHY_TTL_MS = 4 * 60 * 60 * 1000;
const STANDARD_UNHEALTHY_RETRY_MS = 30 * 60 * 1000;
const EXPENSIVE_HEALTHY_TTL_MS = 24 * 60 * 60 * 1000;
const EXPENSIVE_UNHEALTHY_RETRY_MS = 6 * 60 * 60 * 1000;

export interface ModelHealthProbePolicyInput {
  provider: string;
  adapterType: string;
  modelId: string;
  capabilities: string[];
  sampleCostUsd: number | null;
}

export interface ModelHealthProbePolicy {
  mode: "automatic" | "on_demand";
  tier: "cheap" | "standard" | "expensive";
  healthyTtlMs: number;
  unhealthyRetryMs: number;
  jitterRatio: number;
}

export function getModelHealthProbePolicy(
  input: ModelHealthProbePolicyInput,
): ModelHealthProbePolicy {
  const capabilities = new Set(
    (input.capabilities ?? []).map((capability) => capability.trim().toLowerCase()).filter(Boolean),
  );
  const adapterCapabilities = getAdapterCapabilities(input.adapterType);
  const isImage = capabilities.has("image") || adapterCapabilities.imageGeneration;
  if (isImage) {
    return {
      mode: (process.env.MODEL_HEALTH_EXPENSIVE_PROBE_MODE ?? "on_demand") === "automatic"
        ? "automatic"
        : "on_demand",
      tier: "expensive",
      healthyTtlMs: EXPENSIVE_HEALTHY_TTL_MS,
      unhealthyRetryMs: EXPENSIVE_UNHEALTHY_RETRY_MS,
      jitterRatio: 0.35,
    };
  }

  const isLocal = adapterCapabilities.localRuntime || input.provider.trim().toLowerCase() === "local";
  const estimatedCost = input.sampleCostUsd ?? 0;
  if (isLocal || estimatedCost <= 0.0001) {
    return {
      mode: "automatic",
      tier: "cheap",
      healthyTtlMs: CHEAP_HEALTHY_TTL_MS,
      unhealthyRetryMs: CHEAP_UNHEALTHY_RETRY_MS,
      jitterRatio: 0.15,
    };
  }

  return {
    mode: "automatic",
    tier: "standard",
    healthyTtlMs: STANDARD_HEALTHY_TTL_MS,
    unhealthyRetryMs: STANDARD_UNHEALTHY_RETRY_MS,
    jitterRatio: 0.2,
  };
}

export type ProbeFreshness = "unknown" | "fresh" | "due";

export function classifyProbeFreshness(
  nextProbeAt: Date | string | null | undefined,
  now: Date,
): ProbeFreshness {
  if (!nextProbeAt) return "unknown";
  const timestamp = new Date(nextProbeAt).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  return timestamp > now.getTime() ? "fresh" : "due";
}

export function applyProbeJitter(baseMs: number, jitterRatio: number, key: string): number {
  const normalizedKey = key.trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < normalizedKey.length; index += 1) {
    hash = ((hash << 5) - hash + normalizedKey.charCodeAt(index)) | 0;
  }
  const fraction = ((hash >>> 0) % 10_000) / 10_000;
  const offsetRatio = (fraction * 2 - 1) * jitterRatio;
  return Math.max(60_000, Math.round(baseMs * (1 + offsetRatio)));
}
