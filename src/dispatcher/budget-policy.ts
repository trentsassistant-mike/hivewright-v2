import type { Sql } from "postgres";
import { serializeGoalBudgetStatus, type GoalBudgetState } from "@/budget/status";

const BUDGET_PAUSE_REASON = "Paused by budget";

type GoalBudgetPolicyRow = {
  status: string;
  budget_cents: number | null;
  spent_cents: number;
  budget_state: GoalBudgetState | null;
  budget_warning_triggered_at: Date | null;
  budget_enforced_at: Date | null;
  budget_enforcement_reason: string | null;
  updated_at: Date | null;
};

export interface GoalBudgetPolicyResult {
  exceeded: boolean;
  spentCents: number;
  budgetCents: number | null;
  remainingCents: number | null;
  percentUsed: number | null;
  warning: boolean;
  paused: boolean;
  state: GoalBudgetState;
  reason: string | null;
  warningTriggeredAt: Date | null;
  enforcedAt: Date | null;
  lastUpdatedAt: Date | null;
}

export async function evaluateGoalBudgetPolicy(
  sql: Sql,
  goalId: string,
): Promise<GoalBudgetPolicyResult> {
  const [sum] = await sql`
    SELECT COALESCE(SUM(cost_cents), 0)::int as total
    FROM tasks
    WHERE goal_id = ${goalId}
  `;

  const spentCents = Number(sum?.total ?? 0);
  const [goal] = await sql<GoalBudgetPolicyRow[]>`
    SELECT
      status,
      budget_cents,
      spent_cents,
      budget_state,
      budget_warning_triggered_at,
      budget_enforced_at,
      budget_enforcement_reason,
      updated_at
    FROM goals
    WHERE id = ${goalId}
    LIMIT 1
  `;

  const budget = serializeGoalBudgetStatus({
    budgetCents: goal?.budget_cents ?? null,
    spentCents,
    budgetState: goal?.budget_state ?? null,
    warningTriggeredAt: goal?.budget_warning_triggered_at ?? null,
    enforcedAt: goal?.budget_enforced_at ?? null,
    reason: goal?.budget_enforcement_reason ?? null,
    updatedAt: goal?.updated_at ?? null,
  });

  const warningTriggeredAt = budget.warning
    ? goal?.budget_warning_triggered_at ?? new Date()
    : null;
  const enforcedAt = budget.paused
    ? goal?.budget_enforced_at ?? new Date()
    : null;
  const reason = budget.paused ? BUDGET_PAUSE_REASON : null;
  const nextStatus = budget.paused ? "paused" : goal?.status ?? "active";

  const [updated] = await sql<GoalBudgetPolicyRow[]>`
    UPDATE goals
    SET
      spent_cents = ${spentCents},
      status = ${nextStatus},
      budget_state = ${budget.state},
      budget_warning_triggered_at = ${warningTriggeredAt},
      budget_enforced_at = ${enforcedAt},
      budget_enforcement_reason = ${reason},
      updated_at = NOW()
    WHERE id = ${goalId}
    RETURNING
      status,
      budget_cents,
      spent_cents,
      budget_state,
      budget_warning_triggered_at,
      budget_enforced_at,
      budget_enforcement_reason,
      updated_at
  `;

  const persisted = serializeGoalBudgetStatus({
    budgetCents: updated?.budget_cents ?? goal?.budget_cents ?? null,
    spentCents: updated?.spent_cents ?? spentCents,
    budgetState: updated?.budget_state ?? budget.state,
    warningTriggeredAt: updated?.budget_warning_triggered_at ?? warningTriggeredAt,
    enforcedAt: updated?.budget_enforced_at ?? enforcedAt,
    reason: updated?.budget_enforcement_reason ?? reason,
    updatedAt: updated?.updated_at ?? null,
  });

  return {
    exceeded: persisted.paused,
    spentCents: persisted.spentCents,
    budgetCents: persisted.capCents,
    remainingCents: persisted.remainingCents,
    percentUsed: persisted.percentUsed,
    warning: persisted.warning,
    paused: persisted.paused,
    state: persisted.state,
    reason: persisted.reason,
    warningTriggeredAt: (persisted.warningTriggeredAt as Date | null) ?? null,
    enforcedAt: (persisted.enforcedAt as Date | null) ?? null,
    lastUpdatedAt: (persisted.lastUpdatedAt as Date | null) ?? null,
  };
}

export async function pauseOverBudgetGoalsForClaim(sql: Sql): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE goals g
    SET
      status = 'paused',
      budget_state = 'paused',
      budget_warning_triggered_at = COALESCE(g.budget_warning_triggered_at, NOW()),
      budget_enforced_at = COALESCE(g.budget_enforced_at, NOW()),
      budget_enforcement_reason = ${BUDGET_PAUSE_REASON},
      updated_at = NOW()
    WHERE g.status = 'active'
      AND g.budget_cents IS NOT NULL
      AND g.spent_cents >= g.budget_cents
      AND EXISTS (
        SELECT 1
        FROM tasks t
        WHERE t.goal_id = g.id
          AND t.status = 'pending'
          AND (t.retry_after IS NULL OR t.retry_after <= NOW())
      )
    RETURNING g.id
  `;

  return rows.length;
}
