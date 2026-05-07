import { describe, expect, it } from "vitest";
import {
  classifyAdapterBoundaryError,
  healthyProbeResult,
  isCodexRolloutThreadNotFound,
  probeResultFromBoundaryError,
} from "@/adapters/probe-classifier";
import type { AdapterProbe, ProbeResult } from "@/adapters/types";

describe("adapter probe contract", () => {
  it("accepts a single universal probe shape at typecheck time", async () => {
    const probe: AdapterProbe = {
      async probe(): Promise<ProbeResult> {
        return healthyProbeResult({ latencyMs: 12, costEstimateUsd: 0.00001 });
      },
    };

    const result = await probe.probe("provider/model", {
      provider: "provider",
      fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      secrets: { API_KEY: "redacted-in-test" },
    });

    expect(result).toMatchObject({
      healthy: true,
      status: "healthy",
      failureClass: null,
      latencyMs: 12,
      costEstimateUsd: 0.00001,
      reason: {
        code: "probe_ok",
        failureClass: null,
      },
    });
  });
});

describe("classifyAdapterBoundaryError", () => {
  it("maps Codex rollout thread-not-found stderr to runtime_session", () => {
    const stderr =
      "codex_core::session: failed to record rollout items: thread 019dd0b1 not found";

    expect(isCodexRolloutThreadNotFound(stderr)).toBe(true);

    const result = probeResultFromBoundaryError({ stderr, latencyMs: 87 });

    expect(result).toMatchObject({
      healthy: false,
      status: "unhealthy",
      failureClass: "runtime_session",
      latencyMs: 87,
      costEstimateUsd: 0,
      reason: {
        code: "codex_rollout_thread_not_found",
        failureClass: "runtime_session",
        retryable: false,
      },
    });
  });

  it.each([
    ["OpenAI insufficient quota", { statusCode: 429, message: "insufficient_quota" }],
    ["Anthropic monthly cap", { message: "You've hit your limit; resets 10pm" }],
    ["Gemini resource exhausted", { code: "RESOURCE_EXHAUSTED", message: "Quota exceeded" }],
    ["OpenRouter rate limit", { statusCode: 429, message: "Rate limit exceeded" }],
    ["Gemini CLI 429 capacity message", { message: "[API Error: You have exhausted your capacity on this model.]" }],
  ])("maps quota-class example: %s", (_name, input) => {
    expect(classifyAdapterBoundaryError(input)).toMatchObject({
      failureClass: "quota",
      reason: {
        code: "quota_exhausted",
        failureClass: "quota",
        retryable: true,
      },
    });
  });

  it.each([
    ["auth", { statusCode: 401, message: "Invalid API key" }],
    ["scope", { statusCode: 403, message: "insufficient_scope for images.generations" }],
    ["scope", { stdout: "The 'gpt-4.1' model is not supported when using Codex with a ChatGPT account." }],
    ["region", { message: "The model is not available in your region" }],
    ["runtime_session", { stderr: "failed to record rollout items: thread thread-1 not found" }],
    ["gpu_oom", { stderr: "CUDA out of memory while allocating tensor" }],
    ["gateway_retired", { message: "OpenClaw gateway retired" }],
    ["unavailable", { statusCode: 503, message: "service unavailable" }],
    ["timeout", { code: "ETIMEDOUT", message: "request timed out" }],
    ["unknown", { message: "provider returned an unexpected adapter boundary error" }],
  ] as const)("maps %s failures", (failureClass, input) => {
    expect(classifyAdapterBoundaryError(input).failureClass).toBe(failureClass);
  });
});
