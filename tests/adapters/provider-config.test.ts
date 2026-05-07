import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveModel, getModelPricing, getModelEndpoint, calculateCostCents, getKnownModelIds } from "@/adapters/provider-config";

describe("provider-config", () => {
  it("resolves a cloud model to its endpoint", () => {
    const endpoint = getModelEndpoint("anthropic/claude-sonnet-4-6");
    expect(endpoint).toBe("anthropic");
  });

  it("resolves a local model to its endpoint", () => {
    const endpoint = getModelEndpoint("ollama/qwen3:32b");
    expect(endpoint).toBe("ollama");
  });

  it("returns pricing for a known model", () => {
    const pricing = getModelPricing("anthropic/claude-sonnet-4-6");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPer1k).toBeGreaterThan(0);
    expect(pricing!.outputPer1k).toBeGreaterThan(0);
  });

  it("returns the verified GPT-5.5 pricing", () => {
    const pricing = getModelPricing("openai/gpt-5.5");
    expect(pricing).toEqual({ inputPer1k: 0.5, outputPer1k: 3.0 });
  });

  it("prices the codex GPT-5.5 alias identically to the underlying GPT-5.5 model", () => {
    const pricing = getModelPricing("openai-codex/gpt-5.5");
    expect(pricing).toEqual({ inputPer1k: 0.5, outputPer1k: 3.0 });
  });

  it("returns the approved Gemini 3.1 Pro Preview pricing", () => {
    const pricing = getModelPricing("google/gemini-3.1-pro-preview");
    expect(pricing).toEqual({ inputPer1k: 0.2, outputPer1k: 1.2 });
  });

  it("returns the approved Gemini 3 Flash Preview pricing", () => {
    const pricing = getModelPricing("google/gemini-3-flash-preview");
    expect(pricing).toEqual({ inputPer1k: 0.2, outputPer1k: 1.2 });
  });

  it("returns the approved Mistral Large Latest pricing", () => {
    const pricing = getModelPricing("mistral/mistral-large-latest");
    expect(pricing).toEqual({ inputPer1k: 0.05, outputPer1k: 0.15 });
  });

  it("returns the approved Mistral OCR Latest pricing", () => {
    const pricing = getModelPricing("mistral/mistral-ocr-latest");
    expect(pricing).toEqual({ inputPer1k: 0.05, outputPer1k: 0.15 });
  });

  it("does not register Gemini 3.1 Flash Live Preview as a known pricing route", () => {
    expect(getModelPricing("google/gemini-3.1-flash-live-preview")).toBeNull();
    expect(getModelPricing("gemini-3.1-flash-live-preview")).toBeNull();
  });

  it("returns pricing for provider-prefixed and bare Gemini dispatcher IDs", () => {
    expect(getModelPricing("gemini-3.1-pro-preview")).toEqual({ inputPer1k: 0.2, outputPer1k: 1.2 });
    expect(getModelPricing("google/gemini-3.1-flash-lite-preview")).toEqual({ inputPer1k: 0.2, outputPer1k: 1.2 });
    expect(getModelPricing("gemini-3.1-flash-lite-preview")).toEqual({ inputPer1k: 0.2, outputPer1k: 1.2 });
    expect(calculateCostCents("google/gemini-2.0-flash-exp:free", 10_000, 5_000)).toBe(0);
  });

  it("returns null pricing for unknown models", () => {
    const pricing = getModelPricing("ollama/unknown-model");
    expect(pricing).toBeNull();
  });

  it("resolves recommended_model from role to actual model string", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6", null);
    expect(model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses override model when provided", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7");
    expect(model).toBe("anthropic/claude-opus-4-7");
  });

  it("does not include Haiku in the model pricing registry", () => {
    const source = readFileSync("src/adapters/provider-config.ts", "utf8");
    const pricingBody = source.match(/const PRICING:[\s\S]*?const FALLBACK_PRICING/)?.[0] ?? "";

    expect(getKnownModelIds().filter((modelId) => /haiku/i.test(modelId))).toEqual([]);
    expect(pricingBody).not.toMatch(/haiku/i);
    expect(getModelPricing("anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("calculates cost correctly for cloud models", () => {
    const cost = calculateCostCents("anthropic/claude-sonnet-4-6", 10000, 5000);
    expect(cost).toBeGreaterThan(0);
  });

  it("calculates dispatcher-tracked cost for Gemini 3.1 Pro Preview", () => {
    const cost = calculateCostCents("google/gemini-3.1-pro-preview", 10000, 5000);
    expect(cost).toBe(8);
  });

  it("calculates dispatcher-tracked cost for Gemini 3 Flash Preview", () => {
    const cost = calculateCostCents("google/gemini-3-flash-preview", 10000, 5000);
    expect(cost).toBe(8);
  });

  it("calculates dispatcher-tracked cost for Gemini 3.1 Flash Lite Preview", () => {
    const cost = calculateCostCents("google/gemini-3.1-flash-lite-preview", 10000, 5000);
    expect(cost).toBe(8);
  });

  it("calculates dispatcher-tracked cost for Mistral Large Latest", () => {
    const cost = calculateCostCents("mistral/mistral-large-latest", 10_000, 5_000);
    expect(cost).toBe(1);
  });

  it("calculates dispatcher-tracked cost for Mistral OCR Latest", () => {
    const cost = calculateCostCents("mistral/mistral-ocr-latest", 10_000, 5_000);
    expect(cost).toBe(1);
  });

  it("does not treat Gemini 3.1 Flash Live Preview as a known text-model route", () => {
    expect(getKnownModelIds()).not.toContain("google/gemini-3.1-flash-live-preview");
    expect(getModelPricing("google/gemini-3.1-flash-live-preview")).toBeNull();
  });

  it("returns zero cost for local models", () => {
    const cost = calculateCostCents("ollama/qwen3:32b", 10000, 5000);
    expect(cost).toBe(0);
  });
});
