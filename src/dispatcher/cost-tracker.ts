import type { Sql } from "postgres";
import {
  buildUsageDetails,
  calculateEstimatedBillableCostCents,
  normalizeBillableUsage,
  type UsageDetails,
} from "@/usage/billable-usage";
import { enforceAiBudget } from "@/budget/ai-budget-policy";
import { evaluateGoalBudgetPolicy, type GoalBudgetPolicyResult } from "./budget-policy";

export interface TaskCostInput {
  tokensInput?: number;
  totalContextTokens?: number;
  freshInputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number | null;
  cachedInputTokensKnown?: boolean;
  tokensOutput: number;
  costCents?: number;
  estimatedBillableCostCents?: number;
  modelUsed: string;
  adapterUsed?: string | null;
  usageDetails?: UsageDetails;
}

export async function recordTaskCost(
  sql: Sql,
  taskId: string,
  cost: TaskCostInput,
): Promise<void> {
  const usageForCost = normalizeBillableUsage({
    totalInputTokens: cost.totalContextTokens ?? cost.tokensInput,
    freshInputTokens: cost.freshInputTokens,
    cachedInputTokens: cost.cachedInputTokens,
    cacheCreationTokens: cost.cacheCreationTokens,
    cachedInputTokensKnown: cost.cachedInputTokensKnown,
    tokensOutput: cost.tokensOutput,
  });
  const usage = normalizeBillableUsage({
    totalInputTokens: usageForCost.totalContextTokens,
    freshInputTokens: usageForCost.freshInputTokens,
    cachedInputTokens: usageForCost.cachedInputTokens,
    cacheCreationTokens: usageForCost.cacheCreationTokens,
    cachedInputTokensKnown: usageForCost.cachedInputTokensKnown,
    tokensOutput: usageForCost.tokensOutput,
    estimatedBillableCostCents: cost.estimatedBillableCostCents ?? (
      cost.costCents === undefined
        ? calculateEstimatedBillableCostCents(cost.modelUsed, usageForCost)
        : undefined
    ),
    legacyCostCents: cost.costCents,
  });
  const usageDetails = {
    ...buildUsageDetails(usage),
    ...(cost.usageDetails ?? {}),
  };

  await sql`
    UPDATE tasks
    SET
      fresh_input_tokens = ${usage.freshInputTokens},
      cached_input_tokens = ${usage.cachedInputTokens},
      cached_input_tokens_known = ${usage.cachedInputTokensKnown},
      tokens_output = ${usage.tokensOutput},
      total_context_tokens = ${usage.totalContextTokens},
      estimated_billable_cost_cents = ${usage.estimatedBillableCostCents},
      usage_details = ${sql.json(usageDetails)},
      tokens_input = ${usage.legacy.tokensInput},
      cost_cents = ${usage.legacy.costCents},
      model_used = ${cost.modelUsed},
      adapter_used = COALESCE(${cost.adapterUsed ?? null}, adapter_used),
      updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

export type BudgetCheckResult = GoalBudgetPolicyResult;

export async function checkGoalBudget(
  sql: Sql,
  goalId: string,
): Promise<BudgetCheckResult> {
  return evaluateGoalBudgetPolicy(sql, goalId);
}

export async function checkAiBudget(
  sql: Sql,
  hiveId: string,
) {
  return enforceAiBudget(sql, hiveId);
}
