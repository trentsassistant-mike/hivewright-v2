import { describe, expect, it } from "vitest";
import {
  calculateEstimatedBillableCostCents,
  normalizeBillableUsage,
} from "@/usage/billable-usage";

describe("normalizeBillableUsage", () => {
  it("splits cache-aware total input into fresh and cached input", () => {
    const usage = normalizeBillableUsage({
      totalInputTokens: 1_000,
      cachedInputTokens: 400,
      tokensOutput: 250,
      estimatedBillableCostCents: 1,
    });

    expect(usage).toEqual({
      freshInputTokens: 600,
      cachedInputTokens: 400,
      cacheCreationTokens: null,
      cachedInputTokensKnown: true,
      tokensOutput: 250,
      totalContextTokens: 1_000,
      estimatedBillableCostCents: 1,
      legacy: {
        tokensInput: 1_000,
        tokensOutput: 250,
        costCents: 1,
      },
    });
  });

  it("treats missing cache metadata as fresh input without inventing cached savings", () => {
    const usage = normalizeBillableUsage({
      totalInputTokens: 1_000,
      tokensOutput: 250,
      estimatedBillableCostCents: 2,
    });

    expect(usage.freshInputTokens).toBe(1_000);
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.cachedInputTokensKnown).toBe(false);
    expect(usage.totalContextTokens).toBe(1_000);
    expect(usage.estimatedBillableCostCents).toBe(2);
    expect(usage.legacy).toEqual({
      tokensInput: 1_000,
      tokensOutput: 250,
      costCents: 2,
    });
  });

  it("builds total context from explicit fresh and cached input", () => {
    const usage = normalizeBillableUsage({
      freshInputTokens: 700,
      cachedInputTokens: 300,
      tokensOutput: 125,
      estimatedBillableCostCents: 1,
    });

    expect(usage.freshInputTokens).toBe(700);
    expect(usage.cachedInputTokens).toBe(300);
    expect(usage.cacheCreationTokens).toBeNull();
    expect(usage.cachedInputTokensKnown).toBe(true);
    expect(usage.totalContextTokens).toBe(1_000);
    expect(usage.legacy.tokensInput).toBe(1_000);
    expect(usage.legacy.tokensOutput).toBe(125);
  });

  it("preserves explicit cache creation token accounting when providers expose it", () => {
    const usage = normalizeBillableUsage({
      totalInputTokens: 1_200,
      cachedInputTokens: 300,
      cacheCreationTokens: 150,
      tokensOutput: 80,
      estimatedBillableCostCents: 4,
    });

    expect(usage.cacheCreationTokens).toBe(150);
    expect(usage.cachedInputTokens).toBe(300);
    expect(usage.totalContextTokens).toBe(1_200);
  });

  it("estimates billable cost from fresh, cached, and output tokens", () => {
    const cost = calculateEstimatedBillableCostCents("openai/gpt-5.5", {
      freshInputTokens: 6_000,
      cachedInputTokens: 4_000,
      tokensOutput: 2_000,
    });

    expect(cost).toBe(9);
  });
});
