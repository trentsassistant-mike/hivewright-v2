import { describe, it, expect } from "vitest";
import { calculateCostCents, getModelPricing } from "./provider-config";

describe("calculateCostCents", () => {
  it("computes cost for Anthropic Sonnet", () => {
    // 10,000 in + 5,000 out at $0.3/1k + $1.5/1k = 3c + 7.5c = 10.5c → rounds to 11c
    const cents = calculateCostCents("anthropic/claude-sonnet-4-6", 10_000, 5_000);
    expect(cents).toBe(11);
  });

  it("returns 0 for local Ollama models", () => {
    const cents = calculateCostCents("ollama/qwen3.5:27b", 50_000, 25_000);
    expect(cents).toBe(0);
  });

  it("computes cost for OpenClaw gpt-5.4 (the drift model)", () => {
    // 100,000 in + 50,000 out at $0.25/1k + $1.0/1k = 25c + 50c = 75c
    const cents = calculateCostCents("openai-codex/gpt-5.4", 100_000, 50_000);
    expect(cents).toBe(75);
  });

  it("computes gpt-image-2 token pricing at $8/M input and $30/M output", () => {
    expect(calculateCostCents("gpt-image-2", 1_000_000, 1_000_000)).toBe(3800);
    expect(calculateCostCents("gpt-image-2-2026-04-21", 2_500, 1_000)).toBe(5);
    expect(getModelPricing("gpt-image-2-2026-04-21")).toEqual({
      inputPer1k: 0.8,
      outputPer1k: 3.0,
    });
  });

  it("computes cost for Gemini 3.1 Pro Preview", () => {
    const cents = calculateCostCents("google/gemini-3.1-pro-preview", 10_000, 5_000);
    expect(cents).toBe(8);
    expect(getModelPricing("google/gemini-3.1-pro-preview")).toEqual({
      inputPer1k: 0.2,
      outputPer1k: 1.2,
    });
  });

  it("computes cost for provider-prefixed and bare Gemini IDs", () => {
    expect(calculateCostCents("google/gemini-3.1-flash-lite-preview", 10_000, 5_000)).toBe(8);
    expect(calculateCostCents("gemini-3.1-flash-lite-preview", 10_000, 5_000)).toBe(8);
    expect(calculateCostCents("google/gemini-2.0-flash-exp:free", 10_000, 5_000)).toBe(0);
    expect(getModelPricing("google/gemini-3.1-flash-lite-preview")).toEqual({
      inputPer1k: 0.2,
      outputPer1k: 1.2,
    });
    expect(getModelPricing("gemini-3.1-pro-preview")).toEqual({
      inputPer1k: 0.2,
      outputPer1k: 1.2,
    });
    expect(getModelPricing("gemini-3.1-pro-preview-customtools")).toEqual({
      inputPer1k: 0.2,
      outputPer1k: 1.2,
    });
  });

  it("falls back to GPT-4o-class pricing for unknown models", () => {
    // Ensures unknown models don't silently read as $0.
    const cents = calculateCostCents("some-future/unknown-model", 100_000, 50_000);
    expect(cents).toBeGreaterThan(0);
    expect(getModelPricing("some-future/unknown-model")).toBeNull();
  });

  it("handles zero tokens gracefully", () => {
    expect(calculateCostCents("anthropic/claude-sonnet-4-6", 0, 0)).toBe(0);
  });
});
