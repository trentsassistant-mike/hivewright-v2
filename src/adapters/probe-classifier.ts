import type { ProbeFailureClass, ProbeReason, ProbeResult } from "./types";

export interface AdapterBoundaryErrorInput {
  message?: string | null;
  stderr?: string | null;
  stdout?: string | null;
  statusCode?: number | null;
  code?: string | null;
}

export interface ClassifiedProbeFailure {
  failureClass: ProbeFailureClass;
  reason: ProbeReason;
}

export function healthyProbeResult(input: {
  latencyMs: number;
  costEstimateUsd?: number;
  code?: string;
  message?: string;
}): ProbeResult {
  return {
    healthy: true,
    status: "healthy",
    failureClass: null,
    latencyMs: input.latencyMs,
    costEstimateUsd: input.costEstimateUsd ?? 0,
    reason: {
      code: input.code ?? "probe_ok",
      message: input.message ?? "Probe completed successfully.",
      failureClass: null,
      retryable: false,
    },
  };
}

export function unhealthyProbeResult(input: {
  failureClass: ProbeFailureClass;
  reason: Omit<ProbeReason, "failureClass">;
  latencyMs: number;
  costEstimateUsd?: number;
}): ProbeResult {
  return {
    healthy: false,
    status: "unhealthy",
    failureClass: input.failureClass,
    latencyMs: input.latencyMs,
    costEstimateUsd: input.costEstimateUsd ?? 0,
    reason: {
      ...input.reason,
      failureClass: input.failureClass,
    },
  };
}

export function classifyAdapterBoundaryError(input: AdapterBoundaryErrorInput): ClassifiedProbeFailure {
  const statusCode = input.statusCode ?? null;
  const providerCode = normalize(input.code);
  const text = normalize([input.code, input.message, input.stderr, input.stdout].filter(Boolean).join("\n"));

  if (isCodexRolloutThreadNotFound(text)) {
    return failure(
      "runtime_session",
      "codex_rollout_thread_not_found",
      "Codex rollout registration failed because the runtime thread was not found.",
      false,
    );
  }

  if (
    statusCode === 401 ||
    includesAny(text, [
      "unauthorized",
      "invalid api key",
      "invalid_api_key",
      "expired token",
      "auth.json",
      "authentication failed",
    ])
  ) {
    return failure("auth", "auth_failed", "Credential authentication failed.", false);
  }

  if (
    statusCode === 429 ||
    providerCode === "resource_exhausted" ||
    includesAny(text, [
      "quota exceeded",
      "insufficient_quota",
      "rate limit",
      "rate_limit",
      "monthly cap",
      "usage limit",
      "you've hit your limit",
      "resource exhausted",
      "billing hard limit",
      "too many requests",
      "exhausted your capacity",
    ])
  ) {
    return failure("quota", "quota_exhausted", "Provider quota or rate limit is exhausted.", true);
  }

  if (
    statusCode === 403 ||
    includesAny(text, [
      "insufficient_scope",
      "permission denied",
      "not allowed to access",
      "model not enabled",
      "model is not supported",
      "not supported when using codex with a chatgpt account",
      "unsupported model",
      "scope",
    ])
  ) {
    return failure(
      "scope",
      "scope_denied",
      "Credential lacks the scope or model entitlement required for this probe.",
      false,
    );
  }

  if (
    includesAny(text, [
      "unsupported region",
      "region is not supported",
      "not available in your region",
      "geo restricted",
      "location is not supported",
    ])
  ) {
    return failure("region", "region_unavailable", "Model or credential is unavailable in this region.", false);
  }

  if (
    includesAny(text, [
      "cuda out of memory",
      "gpu out of memory",
      "cublas_status_alloc_failed",
      "hip out of memory",
      "out of memory",
      "vram",
    ])
  ) {
    return failure("gpu_oom", "gpu_oom", "Local GPU memory was exhausted during the probe.", true);
  }

  if (
    includesAny(text, [
      "gateway retired",
      "gateway has been retired",
      "openclaw gateway retired",
      "deprecated gateway",
    ])
  ) {
    return failure("gateway_retired", "gateway_retired", "Adapter gateway has been retired and cannot serve probes.", false);
  }

  if (
    statusCode === 408 ||
    providerCode === "etimedout" ||
    providerCode === "timeout" ||
    includesAny(text, ["timed out", "timeout", "deadline exceeded", "etimedout"])
  ) {
    return failure("timeout", "probe_timeout", "Probe timed out before a health result could be established.", true);
  }

  if (
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    includesAny(text, [
      "service unavailable",
      "temporarily unavailable",
      "bad gateway",
      "gateway timeout",
      "econnrefused",
      "connection refused",
      "network error",
    ])
  ) {
    return failure("unavailable", "provider_unavailable", "Provider or local runtime is currently unavailable.", true);
  }

  return failure("unknown", "unknown_probe_failure", "Probe failed with an unclassified adapter boundary error.", true);
}

export function probeResultFromBoundaryError(input: AdapterBoundaryErrorInput & {
  latencyMs: number;
  costEstimateUsd?: number;
}): ProbeResult {
  const classified = classifyAdapterBoundaryError(input);
  return unhealthyProbeResult({
    failureClass: classified.failureClass,
    reason: {
      code: classified.reason.code,
      message: classified.reason.message,
      retryable: classified.reason.retryable,
    },
    latencyMs: input.latencyMs,
    costEstimateUsd: input.costEstimateUsd,
  });
}

export function isCodexRolloutThreadNotFound(text: string): boolean {
  const normalized = normalize(text);
  return (
    normalized.includes("failed to record rollout items") &&
    normalized.includes("thread") &&
    normalized.includes("not found")
  );
}

function failure(
  failureClass: ProbeFailureClass,
  code: string,
  message: string,
  retryable: boolean,
): ClassifiedProbeFailure {
  return {
    failureClass,
    reason: {
      code,
      message,
      failureClass,
      retryable,
    },
  };
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase();
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
