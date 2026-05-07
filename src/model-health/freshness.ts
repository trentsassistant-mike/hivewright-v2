const DEFAULT_MODEL_HEALTH_MAX_AGE_MS = 60 * 60 * 1000;

export interface ModelHealthFreshnessInput {
  status: string | null | undefined;
  lastProbedAt: Date | null | undefined;
  nextProbeAt: Date | null | undefined;
  now?: Date;
  maxAgeMs?: number;
}

export function hasFreshHealthyModelHealth(input: ModelHealthFreshnessInput): boolean {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MODEL_HEALTH_MAX_AGE_MS;

  if (input.status !== "healthy") {
    return false;
  }
  if (!input.lastProbedAt) {
    return false;
  }
  if (now.getTime() - input.lastProbedAt.getTime() > maxAgeMs) {
    return false;
  }
  if (!input.nextProbeAt) {
    return false;
  }
  return input.nextProbeAt.getTime() > now.getTime();
}

export { DEFAULT_MODEL_HEALTH_MAX_AGE_MS };
