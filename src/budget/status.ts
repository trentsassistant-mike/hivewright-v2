export const BUDGET_WARNING_THRESHOLD_PCT = 80;

export type GoalBudgetState = "ok" | "warning" | "paused" | "hard_stopped";

export interface GoalBudgetSnapshot {
  budgetCents: number | null;
  spentCents: number | null;
  budgetState?: GoalBudgetState | null;
  warningTriggeredAt?: Date | string | null;
  enforcedAt?: Date | string | null;
  reason?: string | null;
  updatedAt?: Date | string | null;
}

export interface GoalBudgetStatus {
  capCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  percentUsed: number | null;
  warningThresholdPct: 80;
  warning: boolean;
  paused: boolean;
  state: GoalBudgetState;
  enforcementMode: "pause";
  warningTriggeredAt: Date | string | null;
  enforcedAt: Date | string | null;
  reason: string | null;
  lastUpdatedAt: Date | string | null;
}

function normalizeCents(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function normalizeDate(value: Date | string | null | undefined): Date | string | null {
  return value ?? null;
}

export function deriveGoalBudgetState(snapshot: GoalBudgetSnapshot): GoalBudgetState {
  const capCents = normalizeCents(snapshot.budgetCents);
  const spentCents = normalizeCents(snapshot.spentCents) ?? 0;
  if (capCents === null) {
    return snapshot.budgetState ?? "ok";
  }
  if (spentCents >= capCents) return "paused";
  if (spentCents >= Math.ceil((capCents * BUDGET_WARNING_THRESHOLD_PCT) / 100)) return "warning";
  return "ok";
}

export function serializeGoalBudgetStatus(snapshot: GoalBudgetSnapshot): GoalBudgetStatus {
  const capCents = normalizeCents(snapshot.budgetCents);
  const spentCents = normalizeCents(snapshot.spentCents) ?? 0;
  const state = deriveGoalBudgetState(snapshot);
  const percentUsed = capCents && capCents > 0
    ? Math.trunc((spentCents / capCents) * 100)
    : null;

  return {
    capCents,
    spentCents,
    remainingCents: capCents === null ? null : Math.max(0, capCents - spentCents),
    percentUsed,
    warningThresholdPct: BUDGET_WARNING_THRESHOLD_PCT,
    warning: state === "warning" || state === "paused" || state === "hard_stopped",
    paused: state === "paused" || state === "hard_stopped",
    state,
    enforcementMode: "pause",
    warningTriggeredAt: normalizeDate(snapshot.warningTriggeredAt),
    enforcedAt: normalizeDate(snapshot.enforcedAt),
    reason: snapshot.reason ?? null,
    lastUpdatedAt: normalizeDate(snapshot.updatedAt),
  };
}
