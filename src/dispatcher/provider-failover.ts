export interface ProviderFailoverInput {
  primaryAdapterType: string;
  primaryModel: string;
  fallbackAdapterType: string | null | undefined;
  fallbackModel: string | null | undefined;
  primaryHealthy: boolean;
  fallbackHealthy?: boolean;
}

export interface ProviderFailoverDecision {
  adapterType: string;
  model: string;
  canRun: boolean;
  usedFallback: boolean;
  clearFallbackModel: boolean;
  reason: string;
}

/**
 * Dispatcher provider failover policy:
 * - healthy primary: run primary adapter/model
 * - unhealthy primary + healthy declared fallback: run fallback adapter/model
 * - unhealthy primary without a healthy declared fallback: park before spawn
 *   so known-bad runtime paths do not burn tokens or create recovery churn.
 */
export function decideProviderFailoverRoute(input: ProviderFailoverInput): ProviderFailoverDecision {
  if (input.primaryHealthy) {
    return {
      adapterType: input.primaryAdapterType,
      model: input.primaryModel,
      canRun: true,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_adapter_healthy",
    };
  }

  if (input.fallbackAdapterType && input.fallbackModel && input.fallbackHealthy === true) {
    return {
      adapterType: input.fallbackAdapterType,
      model: input.fallbackModel,
      canRun: true,
      usedFallback: true,
      clearFallbackModel: true,
      reason: "primary_unhealthy_fallback_healthy",
    };
  }

  return {
    adapterType: input.primaryAdapterType,
    model: input.primaryModel,
    canRun: false,
    usedFallback: false,
    clearFallbackModel: false,
    reason:
      input.fallbackAdapterType && input.fallbackModel
        ? "primary_and_fallback_unhealthy"
        : "primary_unhealthy_no_declared_fallback",
  };
}
