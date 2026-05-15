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
  cacheCreationTokens?: number | null;
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
  cacheCreationTokens: number | null;
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

export interface UsageDetails {
  totalInputTokens: number | null;
  freshInputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cachedInputTokensKnown: boolean;
  estimatedBillableCostCents: number | null;
}

export interface PublicUsageSummary {
  promptTokens: number | null;
  outputTokens: number | null;
  costCents: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

function nonNegativeInt(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

export function normalizeBillableUsage(input: BillableUsageInput): NormalizedBillableUsage {
  const explicitFreshInput = nonNegativeInt(input.freshInputTokens);
  const explicitTotalInput = nonNegativeInt(input.totalInputTokens);
  const explicitCachedInput = nonNegativeInt(input.cachedInputTokens);
  const explicitCacheCreationInput = nonNegativeInt(input.cacheCreationTokens);
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
    cacheCreationTokens: explicitCacheCreationInput ?? null,
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

export function buildUsageDetails(usage: NormalizedBillableUsage): UsageDetails {
  return {
    totalInputTokens: usage.totalContextTokens,
    freshInputTokens: usage.freshInputTokens,
    outputTokens: usage.tokensOutput,
    cacheReadTokens: usage.cachedInputTokensKnown ? usage.cachedInputTokens : null,
    cacheCreationTokens: usage.cacheCreationTokens,
    cachedInputTokensKnown: usage.cachedInputTokensKnown,
    estimatedBillableCostCents: usage.estimatedBillableCostCents,
  };
}

function nonNegativeNullableInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

export function parseUsageDetails(value: unknown): UsageDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    totalInputTokens: nonNegativeNullableInt(record.totalInputTokens),
    freshInputTokens: nonNegativeNullableInt(record.freshInputTokens),
    outputTokens: nonNegativeNullableInt(record.outputTokens),
    cacheReadTokens: nonNegativeNullableInt(record.cacheReadTokens),
    cacheCreationTokens: nonNegativeNullableInt(record.cacheCreationTokens),
    cachedInputTokensKnown: Boolean(record.cachedInputTokensKnown),
    estimatedBillableCostCents: nonNegativeNullableInt(record.estimatedBillableCostCents),
  };
}

export function toPublicUsageSummary(input: {
  usageDetails?: unknown;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  costCents?: number | null;
}): PublicUsageSummary {
  const details = parseUsageDetails(input.usageDetails);
  return {
    promptTokens: details?.totalInputTokens ?? nonNegativeNullableInt(input.tokensInput),
    outputTokens: details?.outputTokens ?? nonNegativeNullableInt(input.tokensOutput),
    costCents: details?.estimatedBillableCostCents ?? nonNegativeNullableInt(input.costCents),
    cacheReadTokens: details?.cacheReadTokens ?? null,
    cacheCreationTokens: details?.cacheCreationTokens ?? null,
  };
}
