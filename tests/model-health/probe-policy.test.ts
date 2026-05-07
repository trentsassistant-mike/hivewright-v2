import { describe, expect, it } from "vitest";
import {
  getModelHealthProbePolicy,
  type ModelHealthProbePolicyInput,
} from "@/model-health/probe-policy";

function policyFor(input: Partial<ModelHealthProbePolicyInput>) {
  return getModelHealthProbePolicy({
    adapterType: "codex",
    modelId: "openai-codex/gpt-5.5",
    capabilities: ["text", "code"],
    provider: "openai",
    sampleCostUsd: null,
    ...input,
  });
}

describe("getModelHealthProbePolicy", () => {
  it("keeps cheap text routes on a frequent automatic cadence", () => {
    const policy = policyFor({
      adapterType: "ollama",
      provider: "local",
      modelId: "qwen3:32b",
      capabilities: ["text", "code"],
      sampleCostUsd: 0,
    });

    expect(policy).toMatchObject({
      mode: "automatic",
      tier: "cheap",
    });
    expect(policy.healthyTtlMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(policy.unhealthyRetryMs).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("marks expensive image routes as on-demand by default", () => {
    const policy = policyFor({
      adapterType: "openai-image",
      provider: "openai",
      modelId: "gpt-image-2",
      capabilities: ["image"],
      sampleCostUsd: 0.01,
    });

    expect(policy).toMatchObject({
      mode: "on_demand",
      tier: "expensive",
    });
    expect(policy.healthyTtlMs).toBeGreaterThan(6 * 60 * 60 * 1000);
  });

  it("lets high-cost non-image routes stay automatic but less frequent", () => {
    const policy = policyFor({
      provider: "anthropic",
      adapterType: "claude-code",
      modelId: "anthropic/claude-opus-4-7",
      capabilities: ["text", "reasoning"],
      sampleCostUsd: 0.003,
    });

    expect(policy).toMatchObject({
      mode: "automatic",
      tier: "standard",
    });
    expect(policy.healthyTtlMs).toBeGreaterThan(60 * 60 * 1000);
  });
});
