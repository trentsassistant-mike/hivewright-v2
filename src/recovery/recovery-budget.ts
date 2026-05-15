import type { Sql } from "postgres";

export const RECOVERY_BUDGET_LIMITS = {
  doctorTasksPerFailureFamily: 2,
  openRecoveryDecisionsPerFailureFamily: 1,
  replacementTasksPerFailureFamily: 3,
} as const;

export type OpenRecoveryDecisionStatus = "pending" | "ea_review";

export type OpenRecoveryDecision = {
  id: string;
  status: OpenRecoveryDecisionStatus;
};

export type RecoveryBudget = {
  rootTaskId: string;
  doctorTaskCount: number;
  openRecoveryDecisionCount: number;
  /**
   * IDs + statuses of the open `pending`/`ea_review` decisions consuming
   * the recovery-decision budget. Surfacing the IDs lets operators jump
   * directly to a blocker that is hidden from the default Decisions view
   * (which filters to `pending`).
   */
  openRecoveryDecisions: OpenRecoveryDecision[];
  replacementTaskCount: number;
  replacementTaskLimit: number;
  replacementTaskOverride: RecoveryBudgetReplacementOverride | null;
};

export type RecoveryBudgetRequest = {
  doctorTasksToCreate?: number;
  recoveryDecisionsToCreate?: number;
  replacementTasksToCreate?: number;
  action: string;
  reason: string;
};

export type RecoveryBudgetDecision =
  | { ok: true; budget: RecoveryBudget }
  | { ok: false; budget: RecoveryBudget; reason: string };

export type RecoveryBudgetReplacementOverride = {
  decisionId: string;
  taskFamilyRootId: string;
  replacementTasksPerFailureFamily: number;
  approvedAt: string | null;
};

type RecoveryBudgetOverrideRecord = {
  decision_id: string;
  resolved_at: Date | null;
  route_metadata: unknown;
};

export async function loadRecoveryBudget(sql: Sql, taskId: string): Promise<RecoveryBudget> {
  const [row] = await sql<{
    root_task_id: string;
    doctor_task_count: number;
    open_recovery_decision_count: number;
    open_recovery_decisions: OpenRecoveryDecision[] | null;
    replacement_task_count: number;
  }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_task_id, 0 AS depth
      FROM tasks
      WHERE id = ${taskId}

      UNION ALL

      SELECT parent.id, parent.parent_task_id, ancestors.depth + 1
      FROM tasks parent
      JOIN ancestors ON ancestors.parent_task_id = parent.id
    ),
    root AS (
      SELECT id
      FROM ancestors
      ORDER BY depth DESC
      LIMIT 1
    ),
    family AS (
      SELECT id, parent_task_id, assigned_to, created_by
      FROM tasks
      WHERE id = (SELECT id FROM root)

      UNION ALL

      SELECT child.id, child.parent_task_id, child.assigned_to, child.created_by
      FROM tasks child
      JOIN family ON child.parent_task_id = family.id
    )
    SELECT
      (SELECT id FROM root) AS root_task_id,
      COUNT(*) FILTER (WHERE family.assigned_to = 'doctor')::int AS doctor_task_count,
      COUNT(*) FILTER (
        WHERE family.id != (SELECT id FROM root)
          AND family.assigned_to != 'doctor'
          AND (
            family.created_by IN ('doctor', 'quality-doctor', 'goal-supervisor')
            OR (family.assigned_to = 'goal-supervisor' AND family.created_by = 'dispatcher')
          )
      )::int AS replacement_task_count,
      (
        SELECT COUNT(*)::int
        FROM decisions d
        WHERE d.task_id IN (SELECT id FROM family)
          AND d.status IN ('pending', 'ea_review')
      ) AS open_recovery_decision_count,
      (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object('id', d.id, 'status', d.status)
            ORDER BY d.created_at
          ),
          '[]'::jsonb
        )
        FROM decisions d
        WHERE d.task_id IN (SELECT id FROM family)
          AND d.status IN ('pending', 'ea_review')
      ) AS open_recovery_decisions
    FROM family
  `;

  const replacementTaskOverride = await loadReplacementTaskOverride(sql, row.root_task_id);
  const replacementTaskLimit = replacementTaskOverride?.replacementTasksPerFailureFamily ??
    RECOVERY_BUDGET_LIMITS.replacementTasksPerFailureFamily;

  return {
    rootTaskId: row.root_task_id,
    doctorTaskCount: Number(row.doctor_task_count),
    openRecoveryDecisionCount: Number(row.open_recovery_decision_count),
    openRecoveryDecisions: row.open_recovery_decisions ?? [],
    replacementTaskCount: Number(row.replacement_task_count),
    replacementTaskLimit,
    replacementTaskOverride,
  };
}

export async function checkRecoveryBudget(
  sql: Sql,
  taskId: string,
  request: RecoveryBudgetRequest,
): Promise<RecoveryBudgetDecision> {
  const budget = await loadRecoveryBudget(sql, taskId);
  const violations = recoveryBudgetViolations(budget, request);

  if (violations.length === 0) {
    return { ok: true, budget };
  }

  return {
    ok: false,
    budget,
    reason: formatRecoveryBudgetReason(budget, request, violations),
  };
}

export async function parkTaskIfRecoveryBudgetExceeded(
  sql: Sql,
  taskId: string,
  request: RecoveryBudgetRequest,
): Promise<RecoveryBudgetDecision> {
  const decision = await checkRecoveryBudget(sql, taskId, request);
  if (decision.ok) return decision;

  await sql`
    UPDATE tasks
    SET status = 'unresolvable', failure_reason = ${decision.reason}, updated_at = NOW()
    WHERE id = ${taskId}
  `;
  return decision;
}

function recoveryBudgetViolations(budget: RecoveryBudget, request: RecoveryBudgetRequest): string[] {
  const doctorTaskTotal = budget.doctorTaskCount + (request.doctorTasksToCreate ?? 0);
  const openDecisionTotal = budget.openRecoveryDecisionCount + (request.recoveryDecisionsToCreate ?? 0);
  const replacementTaskTotal = budget.replacementTaskCount + (request.replacementTasksToCreate ?? 0);
  const createsRecoveryWork =
    (request.doctorTasksToCreate ?? 0) > 0 ||
    (request.recoveryDecisionsToCreate ?? 0) > 0 ||
    (request.replacementTasksToCreate ?? 0) > 0;
  const violations: string[] = [];

  if (doctorTaskTotal > RECOVERY_BUDGET_LIMITS.doctorTasksPerFailureFamily) {
    violations.push(
      `doctor tasks ${doctorTaskTotal}/${RECOVERY_BUDGET_LIMITS.doctorTasksPerFailureFamily}`,
    );
  }
  if (
    openDecisionTotal > RECOVERY_BUDGET_LIMITS.openRecoveryDecisionsPerFailureFamily ||
    (createsRecoveryWork &&
      budget.openRecoveryDecisionCount >= RECOVERY_BUDGET_LIMITS.openRecoveryDecisionsPerFailureFamily)
  ) {
    violations.push(
      `open recovery decisions ${openDecisionTotal}/${RECOVERY_BUDGET_LIMITS.openRecoveryDecisionsPerFailureFamily}`,
    );
  }
  if (replacementTaskTotal > budget.replacementTaskLimit) {
    violations.push(
      `replacement tasks ${replacementTaskTotal}/${budget.replacementTaskLimit}`,
    );
  }

  return violations;
}

function formatRecoveryBudgetReason(
  budget: RecoveryBudget,
  request: RecoveryBudgetRequest,
  violations: string[],
): string {
  // Default Decisions view filters to status='pending', so an `ea_review`
  // decision can silently consume the recovery budget while remaining
  // invisible to operators. Surface those IDs in the error so anyone
  // triaging a blocked family can find the hidden blocker.
  const eaReview = budget.openRecoveryDecisions.filter(
    (d) => d.status === "ea_review",
  );
  const pending = budget.openRecoveryDecisions.filter(
    (d) => d.status === "pending",
  );
  const blockerSegments: string[] = [];
  if (eaReview.length > 0) {
    blockerSegments.push(
      `${eaReview.length} in ea_review (decision id${eaReview.length === 1 ? "" : "s"}: ${eaReview.map((d) => d.id).join(", ")})`,
    );
  }
  if (pending.length > 0) {
    blockerSegments.push(
      `${pending.length} pending owner (decision id${pending.length === 1 ? "" : "s"}: ${pending.map((d) => d.id).join(", ")})`,
    );
  }
  const blockerSentence =
    blockerSegments.length > 0
      ? `Blocking decisions: ${blockerSegments.join("; ")}.`
      : "";
  const replacementOverrideSentence = budget.replacementTaskOverride
    ? `Replacement override: decision ${budget.replacementTaskOverride.decisionId} authorizes ${budget.replacementTaskLimit} replacement tasks for this family.`
    : "";
  return [
    `Recovery budget exhausted for task family rooted at ${budget.rootTaskId}.`,
    `Blocked action: ${request.action}.`,
    `Budget breach: ${violations.join(", ")}.`,
    `Open recovery decisions: ${budget.openRecoveryDecisionCount}/${RECOVERY_BUDGET_LIMITS.openRecoveryDecisionsPerFailureFamily}.`,
    blockerSentence,
    replacementOverrideSentence,
    `Current budget: doctor tasks ${budget.doctorTaskCount}/${RECOVERY_BUDGET_LIMITS.doctorTasksPerFailureFamily},`,
    `open recovery decisions ${budget.openRecoveryDecisionCount}/${RECOVERY_BUDGET_LIMITS.openRecoveryDecisionsPerFailureFamily},`,
    `replacement tasks ${budget.replacementTaskCount}/${budget.replacementTaskLimit}.`,
    `Original reason: ${request.reason}`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

async function loadReplacementTaskOverride(
  sql: Sql,
  rootTaskId: string,
): Promise<RecoveryBudgetReplacementOverride | null> {
  const rows = await sql<RecoveryBudgetOverrideRecord[]>`
    WITH RECURSIVE family AS (
      SELECT id
      FROM tasks
      WHERE id = ${rootTaskId}

      UNION ALL

      SELECT child.id
      FROM tasks child
      JOIN family ON child.parent_task_id = family.id
    )
    SELECT
      id AS decision_id,
      resolved_at,
      route_metadata
    FROM decisions
    WHERE status = 'resolved'
      AND task_id IN (SELECT id FROM family)
      AND route_metadata IS NOT NULL
  `;

  let selected: RecoveryBudgetReplacementOverride | null = null;
  for (const row of rows) {
    const parsed = parseReplacementTaskOverride(row, rootTaskId);
    if (!parsed) continue;
    if (!selected || parsed.replacementTasksPerFailureFamily > selected.replacementTasksPerFailureFamily) {
      selected = parsed;
    }
  }

  return selected;
}

function parseReplacementTaskOverride(
  row: RecoveryBudgetOverrideRecord,
  expectedRootTaskId: string,
): RecoveryBudgetReplacementOverride | null {
  if (!isRecord(row.route_metadata)) return null;
  const payload = getOverrideRecord(
    row.route_metadata.recoveryBudgetOverride ?? row.route_metadata.recovery_budget_override,
  );
  if (!payload) return null;

  const enabled = booleanField(payload, ["enabled"], true);
  const taskFamilyRootId = stringField(payload, ["taskFamilyRootId", "task_family_root_id"]);
  const replacementTasksPerFailureFamily = integerField(
    payload,
    ["replacementTasksPerFailureFamily", "replacement_tasks_per_failure_family"],
  );
  if (!enabled || taskFamilyRootId !== expectedRootTaskId || replacementTasksPerFailureFamily === null) {
    return null;
  }
  if (replacementTasksPerFailureFamily <= RECOVERY_BUDGET_LIMITS.replacementTasksPerFailureFamily) {
    return null;
  }

  return {
    decisionId: row.decision_id,
    taskFamilyRootId,
    replacementTasksPerFailureFamily,
    approvedAt: stringField(payload, ["approvedAt", "approved_at"]) ?? row.resolved_at?.toISOString() ?? null,
  };
}

function getOverrideRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function integerField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return null;
}

function booleanField(record: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return fallback;
}
