import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_BUDGET_CAP_CENTS,
  deriveAiBudgetStatus,
  effectiveTaskSpendCents,
} from "@/budget/ai-budget";

describe("deriveAiBudgetStatus", () => {
  it("stays normal below the 80 percent warning threshold", () => {
    expect(deriveAiBudgetStatus({
      capCents: DEFAULT_AI_BUDGET_CAP_CENTS,
      consumedCents: 79_999,
      blocksNewWork: false,
    })).toMatchObject({
      capCents: 100_000,
      consumedCents: 79_999,
      remainingCents: 20_001,
      progressPct: 80,
      state: "normal",
      overBudgetCents: 0,
      enforcement: {
        mode: "creation_pause",
        blocksNewWork: false,
      },
    });
  });

  it("enters warning at 80 percent and preserves the remaining budget", () => {
    expect(deriveAiBudgetStatus({
      capCents: DEFAULT_AI_BUDGET_CAP_CENTS,
      consumedCents: 80_000,
      blocksNewWork: false,
    })).toMatchObject({
      remainingCents: 20_000,
      progressPct: 80,
      state: "warning",
    });
  });

  it("enters breached at 100 percent, clamps remaining to zero, and caps progress at 100", () => {
    expect(deriveAiBudgetStatus({
      capCents: DEFAULT_AI_BUDGET_CAP_CENTS,
      consumedCents: 100_090,
      blocksNewWork: true,
      reason: "Paused by AI spend budget breach",
    })).toMatchObject({
      remainingCents: 0,
      progressPct: 100,
      state: "breached",
      overBudgetCents: 90,
      enforcement: {
        mode: "creation_pause",
        blocksNewWork: true,
        reason: "Paused by AI spend budget breach",
      },
    });
  });
});

describe("effectiveTaskSpendCents", () => {
  it("prefers estimated billable cost, then recorded cost, then token fallback", () => {
    expect(effectiveTaskSpendCents({
      estimatedBillableCostCents: 123,
      costCents: 999,
      tokensInput: 100_000,
      tokensOutput: 50_000,
      modelUsed: "openai-codex/gpt-5.4",
    })).toBe(123);

    expect(effectiveTaskSpendCents({
      estimatedBillableCostCents: null,
      costCents: 88,
      tokensInput: 100_000,
      tokensOutput: 50_000,
      modelUsed: "openai-codex/gpt-5.4",
    })).toBe(88);

    expect(effectiveTaskSpendCents({
      estimatedBillableCostCents: null,
      costCents: null,
      tokensInput: 1_000,
      tokensOutput: 1_000,
      modelUsed: "openai/gpt-5.5",
    })).toBe(4);
  });
});
