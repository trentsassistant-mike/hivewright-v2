import type { Sql } from "postgres";
import {
  calculateEstimatedBillableCostCents,
  normalizeBillableUsage,
} from "@/usage/billable-usage";

export interface TaskCostInput {
  tokensInput?: number;
  totalContextTokens?: number;
  freshInputTokens?: number;
  cachedInputTokens?: number;
  cachedInputTokensKnown?: boolean;
  tokensOutput: number;
  costCents?: number;
  estimatedBillableCostCents?: number;
  modelUsed: string;
  adapterUsed?: string | null;
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
    cachedInputTokensKnown: cost.cachedInputTokensKnown,
    tokensOutput: cost.tokensOutput,
  });
  const usage = normalizeBillableUsage({
    totalInputTokens: usageForCost.totalContextTokens,
    freshInputTokens: usageForCost.freshInputTokens,
    cachedInputTokens: usageForCost.cachedInputTokens,
    cachedInputTokensKnown: usageForCost.cachedInputTokensKnown,
    tokensOutput: usageForCost.tokensOutput,
    estimatedBillableCostCents: cost.estimatedBillableCostCents ?? (
      cost.costCents === undefined
        ? calculateEstimatedBillableCostCents(cost.modelUsed, usageForCost)
        : undefined
    ),
    legacyCostCents: cost.costCents,
  });

  await sql`
    UPDATE tasks
    SET
      fresh_input_tokens = ${usage.freshInputTokens},
      cached_input_tokens = ${usage.cachedInputTokens},
      cached_input_tokens_known = ${usage.cachedInputTokensKnown},
      tokens_output = ${usage.tokensOutput},
      total_context_tokens = ${usage.totalContextTokens},
      estimated_billable_cost_cents = ${usage.estimatedBillableCostCents},
      tokens_input = ${usage.legacy.tokensInput},
      cost_cents = ${usage.legacy.costCents},
      model_used = ${cost.modelUsed},
      adapter_used = COALESCE(${cost.adapterUsed ?? null}, adapter_used),
      updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

export interface BudgetCheckResult {
  exceeded: boolean;
  spentCents: number;
  budgetCents: number | null;
}

export async function checkGoalBudget(
  sql: Sql,
  goalId: string,
): Promise<BudgetCheckResult> {
  const [sum] = await sql`
    SELECT COALESCE(SUM(cost_cents), 0)::int as total
    FROM tasks WHERE goal_id = ${goalId}
  `;

  const spentCents = sum.total;

  await sql`
    UPDATE goals SET spent_cents = ${spentCents}, updated_at = NOW()
    WHERE id = ${goalId}
  `;

  const [goal] = await sql`
    SELECT budget_cents FROM goals WHERE id = ${goalId}
  `;

  return {
    exceeded: goal?.budget_cents !== null && spentCents >= goal?.budget_cents,
    spentCents,
    budgetCents: goal?.budget_cents ?? null,
  };
}
