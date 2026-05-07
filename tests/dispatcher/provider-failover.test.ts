import { describe, expect, it } from "vitest";
import { decideProviderFailoverRoute } from "@/dispatcher/provider-failover";

describe("provider failover drill routing", () => {
  it("keeps a healthy Claude primary on its configured adapter and model", () => {
    const decision = decideProviderFailoverRoute({
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.4",
      primaryHealthy: true,
      fallbackHealthy: true,
    });

    expect(decision).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      canRun: true,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_adapter_healthy",
    });
  });

  it("routes a Claude outage to the declared Codex fallback without provider credentials", () => {
    const decision = decideProviderFailoverRoute({
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.4",
      primaryHealthy: false,
      fallbackHealthy: true,
    });

    expect(decision).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.4",
      canRun: true,
      usedFallback: true,
      clearFallbackModel: true,
      reason: "primary_unhealthy_fallback_healthy",
    });
  });

  it("parks instead of spawning when both primary and fallback are unhealthy", () => {
    const decision = decideProviderFailoverRoute({
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.4",
      primaryHealthy: false,
      fallbackHealthy: false,
    });

    expect(decision).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      canRun: false,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_and_fallback_unhealthy",
    });
  });

  it("parks instead of spawning when a role has no declared fallback path", () => {
    const decision = decideProviderFailoverRoute({
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: null,
      fallbackModel: null,
      primaryHealthy: false,
    });

    expect(decision).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      canRun: false,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_unhealthy_no_declared_fallback",
    });
  });
});
