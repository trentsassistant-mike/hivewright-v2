import { getEffectiveModelPricing } from "@/adapters/provider-config";

export interface BillableUsageInput {
  /**
   * Provider-reported total input context. For OpenAI/Codex-style responses this
   * already includes cached input tokens.
   */
  totalInputTokens?: number | null;
  /**
   * Provider-reported non-cached input. For Claude-style responses this can be
   * built from input_tokens + cache_creation_input_tokens.
   */
  freshInputTokens?: number | null;
  cachedInputTokens?: number | null;
  cachedInputTokensKnown?: boolean | null;
  tokensOutput?: number | null;
  estimatedBillableCostCents?: number | null;
  legacyCostCents?: number | null;
}

export interface BillableCostTokens {
  freshInputTokens: number;
  cachedInputTokens: number;
  tokensOutput: number;
}

export interface NormalizedBillableUsage {
  freshInputTokens: number;
  cachedInputTokens: number;
  cachedInputTokensKnown: boolean;
  tokensOutput: number;
  totalContextTokens: number;
  estimatedBillableCostCents: number;
  legacy: {
    tokensInput: number;
    tokensOutput: number;
    costCents: number;
  };
}

function nonNegativeInt(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

export function normalizeBillableUsage(input: BillableUsageInput): NormalizedBillableUsage {
  const explicitFreshInput = nonNegativeInt(input.freshInputTokens);
  const explicitTotalInput = nonNegativeInt(input.totalInputTokens);
  const explicitCachedInput = nonNegativeInt(input.cachedInputTokens);
  const cachedInputTokensKnown =
    typeof input.cachedInputTokensKnown === "boolean"
      ? input.cachedInputTokensKnown
      : explicitCachedInput !== undefined;
  const cachedInputTokens = cachedInputTokensKnown ? (explicitCachedInput ?? 0) : 0;

  let totalContextTokens = explicitTotalInput;
  let freshInputTokens = explicitFreshInput;

  if (totalContextTokens === undefined && freshInputTokens !== undefined) {
    totalContextTokens = freshInputTokens + cachedInputTokens;
  }

  if (totalContextTokens === undefined) {
    totalContextTokens = 0;
  }

  if (freshInputTokens === undefined) {
    if (cachedInputTokensKnown) {
      freshInputTokens = Math.max(0, totalContextTokens - cachedInputTokens);
    } else {
      freshInputTokens = totalContextTokens;
    }
  }

  totalContextTokens = Math.max(totalContextTokens, freshInputTokens + cachedInputTokens);

  const tokensOutput = nonNegativeInt(input.tokensOutput) ?? 0;
  const estimatedBillableCostCents =
    nonNegativeInt(input.estimatedBillableCostCents) ??
    nonNegativeInt(input.legacyCostCents) ??
    0;

  return {
    freshInputTokens,
    cachedInputTokens,
    cachedInputTokensKnown,
    tokensOutput,
    totalContextTokens,
    estimatedBillableCostCents,
    legacy: {
      tokensInput: totalContextTokens,
      tokensOutput,
      costCents: estimatedBillableCostCents,
    },
  };
}

export function calculateEstimatedBillableCostCents(
  model: string,
  usage: BillableCostTokens,
): number {
  const pricing = getEffectiveModelPricing(model);
  const cachedInputPer1k = pricing.cachedInputPer1k ?? pricing.inputPer1k;

  return Math.round(
    (usage.freshInputTokens / 1000) * pricing.inputPer1k +
      (usage.cachedInputTokens / 1000) * cachedInputPer1k +
      (usage.tokensOutput / 1000) * pricing.outputPer1k,
  );
}
