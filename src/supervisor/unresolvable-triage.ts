import type { Sql } from "postgres";
import { createDoctorTask } from "@/doctor";
import {
  checkModelSpawnHealth,
  type ModelSpawnHealthDecision,
  type ModelSpawnHealthInput,
} from "@/model-health/spawn-gate";

export type UnresolvableTriageOutcome =
  | "retryable"
  | "duplicate_historical"
  | "fixed_by_later_work"
  | "needs_doctor"
  | "needs_ea_review"
  | "genuinely_owner_blocked";

export type UnresolvableTriageModelHealthChecker = (
  sql: Sql,
  input: ModelSpawnHealthInput,
) => Promise<ModelSpawnHealthDecision>;

export interface UnresolvableTriageResult {
  scanned: number;
  touched: number;
  byOutcome: Record<UnresolvableTriageOutcome, number>;
}

type RouteSelectionHealthEvidence = {
  canRun: boolean;
  status: ModelSpawnHealthDecision["status"];
  reason: string;
  failureReason: string | null;
};

type EvidenceConfidence = "low" | "medium" | "high";

type EvidencePackageRef = {
  status: "not_available";
  reason: string;
};

type RouteSelectionEvidence = {
  schemaVersion: 1;
  outcome: UnresolvableTriageOutcome;
  route: { adapterType: string; modelId: string } | null;
  health: RouteSelectionHealthEvidence | null;
  context: {
    reason: string;
    sourceTaskId: string;
    timestamp: string;
  };
  links: {
    decisionId: string | null;
    spawnedTaskId: string | null;
    supersedingTaskId: string | null;
    fixTaskId: string | null;
  };
  source_confidence: EvidenceConfidence;
  execution_confidence: EvidenceConfidence;
  legacy_evidence_confidence: EvidenceConfidence;
  packaging_schema_version: 1;
  provider: string | null;
  runtime: string | null;
  trace_package_ref: EvidencePackageRef;
  output_package_ref: EvidencePackageRef;
  evaluation_package_ref: EvidencePackageRef;
  capture_limitations: string[];
};

interface UnresolvableTaskRow {
  id: string;
  hive_id: string;
  goal_id: string | null;
  parent_task_id: string | null;
  assigned_to: string;
  title: string;
  failure_reason: string | null;
  adapter_override: string | null;
  model_override: string | null;
  model_used: string | null;
  role_adapter_type: string | null;
  created_at: Date;
}

const TRIAGE_DECISION_KIND = "unresolvable_task_triage";
const RECOVERY_CREATORS = ["doctor", "hive-supervisor", "goal-supervisor", "dispatcher"];

function emptyCounts(): Record<UnresolvableTriageOutcome, number> {
  return {
    retryable: 0,
    duplicate_historical: 0,
    fixed_by_later_work: 0,
    needs_doctor: 0,
    needs_ea_review: 0,
    genuinely_owner_blocked: 0,
  };
}

export async function reconcileUnresolvableTasks(
  sql: Sql,
  hiveId: string,
  input: {
    now?: Date;
    limit?: number;
    checkModelHealth?: UnresolvableTriageModelHealthChecker;
  } = {},
): Promise<UnresolvableTriageResult> {
  const rows = await loadUntriagedRows(sql, hiveId, input.limit ?? 50);
  const result: UnresolvableTriageResult = {
    scanned: rows.length,
    touched: 0,
    byOutcome: emptyCounts(),
  };
  const checkHealth = input.checkModelHealth ?? checkModelSpawnHealth;

  for (const task of rows) {
    const outcome = await classifyAndApply(sql, task, {
      now: input.now ?? new Date(),
      checkHealth,
    });
    if (!outcome) continue;
    result.byOutcome[outcome] += 1;
    result.touched += 1;
  }

  return result;
}

async function loadUntriagedRows(
  sql: Sql,
  hiveId: string,
  limit: number,
): Promise<UnresolvableTaskRow[]> {
  return sql<UnresolvableTaskRow[]>`
    SELECT
      t.id,
      t.hive_id,
      t.goal_id,
      t.parent_task_id,
      t.assigned_to,
      t.title,
      t.failure_reason,
      t.adapter_override,
      t.model_override,
      t.model_used,
      rt.adapter_type AS role_adapter_type,
      t.created_at
    FROM tasks t
    LEFT JOIN role_templates rt ON rt.slug = t.assigned_to
    WHERE t.hive_id = ${hiveId}::uuid
      AND t.status = 'unresolvable'
      AND NOT EXISTS (
        SELECT 1
        FROM decisions d
        WHERE d.task_id = t.id
          AND d.status IN ('ea_review', 'pending', 'resolved')
          AND d.kind = ${TRIAGE_DECISION_KIND}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM tasks child
        WHERE child.parent_task_id = t.id
          AND child.assigned_to = 'doctor'
          AND child.status IN ('pending', 'active', 'claimed', 'running', 'in_review', 'blocked')
      )
    ORDER BY t.updated_at ASC, t.created_at ASC
    LIMIT ${limit}
  `;
}

async function classifyAndApply(
  sql: Sql,
  task: UnresolvableTaskRow,
  input: {
    now: Date;
    checkHealth: UnresolvableTriageModelHealthChecker;
  },
): Promise<UnresolvableTriageOutcome | null> {
  const recoveredBy = await hasLaterCompletedRecovery(sql, task);
  if (recoveredBy) {
    await markFixedByLaterWork(sql, task, buildRouteSelectionEvidence(task, {
      outcome: "fixed_by_later_work",
      now: input.now,
      fixTaskId: recoveredBy.fixTaskId,
    }));
    return "fixed_by_later_work";
  }

  const replacement = await hasLaterReplacement(sql, task);
  if (replacement) {
    await markDuplicateHistorical(sql, task, buildRouteSelectionEvidence(task, {
      outcome: "duplicate_historical",
      now: input.now,
      supersedingTaskId: replacement.id,
    }));
    return "duplicate_historical";
  }

  if (isRuntimeFailure(task.failure_reason)) {
    const route = taskRoute(task);
    let health: ModelSpawnHealthDecision | null = null;
    if (route) {
      health = await input.checkHealth(sql, {
        hiveId: task.hive_id,
        adapterType: route.adapterType,
        modelId: route.modelId,
        now: input.now,
      });
      if (health.canRun) {
        await retryTask(sql, task, route, buildRouteSelectionEvidence(task, {
          outcome: "retryable",
          now: input.now,
          route,
          health,
        }));
        return "retryable";
      }
    }
    const doctorTask = await createDoctorTask(sql, task.id);
    await persistTaskRouteSelectionEvidence(sql, task.id, buildRouteSelectionEvidence(task, {
      outcome: "needs_doctor",
      now: input.now,
      route,
      health,
      spawnedTaskId: readRecordId(doctorTask),
    }));
    return "needs_doctor";
  }

  if (isOwnerJudgementFailure(task.failure_reason)) {
    await createEaReviewDecision(sql, task, {
      title: `Unresolvable task needs owner judgement: ${task.title}`,
      context: [
        "Hive Supervisor triaged an unresolvable task and found a genuine owner judgement requirement.",
        "",
        `Task: ${task.title}`,
        `Failure reason: ${task.failure_reason ?? "Unknown"}`,
      ].join("\n"),
      recommendation:
        "EA should review the context first and only promote this to the owner if judgement is still required.",
      priority: "urgent",
      outcome: "genuinely_owner_blocked",
      now: input.now,
    });
    return "genuinely_owner_blocked";
  }

  if (isEaReviewFailure(task.failure_reason)) {
    await createEaReviewDecision(sql, task, {
      title: `EA review needed for unresolvable task: ${task.title}`,
      context: [
        "Hive Supervisor triaged an unresolvable task that may be recoverable through governance, credentials, connector setup, or existing owner context.",
        "",
        `Task: ${task.title}`,
        `Failure reason: ${task.failure_reason ?? "Unknown"}`,
      ].join("\n"),
      recommendation:
        "EA should attempt autonomous reconciliation before exposing any decision to the owner.",
      priority: "high",
      outcome: "needs_ea_review",
      now: input.now,
    });
    return "needs_ea_review";
  }

  const doctorTask = await createDoctorTask(sql, task.id);
  await persistTaskRouteSelectionEvidence(sql, task.id, buildRouteSelectionEvidence(task, {
    outcome: "needs_doctor",
    now: input.now,
    spawnedTaskId: readRecordId(doctorTask),
  }));
  return "needs_doctor";
}

async function hasLaterCompletedRecovery(
  sql: Sql,
  task: UnresolvableTaskRow,
): Promise<{ fixTaskId: string | null } | null> {
  if (task.goal_id) {
    const [goal] = await sql<{ id: string }[]>`
      SELECT id
      FROM goals
      WHERE id = ${task.goal_id}
        AND hive_id = ${task.hive_id}
        AND status = 'achieved'
      LIMIT 1
    `;
    if (goal) return { fixTaskId: null };
  }

  if (!task.parent_task_id) return null;
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM tasks
    WHERE hive_id = ${task.hive_id}
      AND parent_task_id = ${task.parent_task_id}
      AND id != ${task.id}
      AND status = 'completed'
      AND created_at > ${task.created_at}
    LIMIT 1
  `;
  return row ? { fixTaskId: row.id } : null;
}

async function hasLaterReplacement(
  sql: Sql,
  task: UnresolvableTaskRow,
): Promise<{ id: string } | null> {
  if (!task.parent_task_id) return null;
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM tasks
    WHERE hive_id = ${task.hive_id}
      AND parent_task_id = ${task.parent_task_id}
      AND id != ${task.id}
      AND created_at > ${task.created_at}
      AND created_by IN ${sql(RECOVERY_CREATORS)}
      AND status IN ('pending', 'active', 'claimed', 'running', 'in_review', 'blocked', 'completed')
    LIMIT 1
  `;
  return row ?? null;
}

async function markFixedByLaterWork(
  sql: Sql,
  task: UnresolvableTaskRow,
  evidence: RouteSelectionEvidence,
): Promise<void> {
  await sql`
    UPDATE tasks
    SET status = 'completed',
        result_summary = COALESCE(
          result_summary || E'\n\n' || ${"[hive-supervisor triage] closed as fixed by later completed work."},
          ${"[hive-supervisor triage] closed as fixed by later completed work."}
        ),
        failure_reason = NULL,
        completed_at = COALESCE(completed_at, NOW()),
        route_selection_evidence = ${sql.json(evidence)},
        updated_at = NOW()
    WHERE id = ${task.id}
  `;
}

async function markDuplicateHistorical(
  sql: Sql,
  task: UnresolvableTaskRow,
  evidence: RouteSelectionEvidence,
): Promise<void> {
  await sql`
    UPDATE tasks
    SET status = 'superseded',
        result_summary = COALESCE(
          result_summary || E'\n\n' || ${"[hive-supervisor triage] archived as duplicate historical recovery noise."},
          ${"[hive-supervisor triage] archived as duplicate historical recovery noise."}
        ),
        route_selection_evidence = ${sql.json(evidence)},
        updated_at = NOW()
    WHERE id = ${task.id}
  `;
}

async function retryTask(
  sql: Sql,
  task: UnresolvableTaskRow,
  route: { adapterType: string; modelId: string },
  evidence: RouteSelectionEvidence,
): Promise<void> {
  await sql`
    UPDATE tasks
    SET status = 'pending',
        retry_count = 0,
        retry_after = NULL,
        failure_reason = COALESCE(
          failure_reason || E'\n\n' || ${`[hive-supervisor triage] retried after model health recovered for ${route.adapterType}/${route.modelId}.`},
          ${`[hive-supervisor triage] retried after model health recovered for ${route.adapterType}/${route.modelId}.`}
        ),
        route_selection_evidence = ${sql.json(evidence)},
        updated_at = NOW()
    WHERE id = ${task.id}
  `;
}

async function createEaReviewDecision(
  sql: Sql,
  task: UnresolvableTaskRow,
  input: {
    title: string;
    context: string;
    recommendation: string;
    priority: "high" | "urgent";
    outcome: Extract<UnresolvableTriageOutcome, "needs_ea_review" | "genuinely_owner_blocked">;
    now: Date;
  },
): Promise<void> {
  const [existing] = await sql<{ id: string }[]>`
    SELECT id
    FROM decisions
    WHERE task_id = ${task.id}
      AND kind = ${TRIAGE_DECISION_KIND}
      AND status IN ('ea_review', 'pending', 'resolved')
    LIMIT 1
  `;
  if (existing) {
    const evidence = buildRouteSelectionEvidence(task, {
      outcome: input.outcome,
      now: input.now,
      decisionId: existing.id,
    });
    await persistTaskRouteSelectionEvidence(sql, task.id, evidence);
    await sql`
      UPDATE decisions
      SET route_metadata = ${sql.json(evidence)}
      WHERE id = ${existing.id}
    `;
    return;
  }

  const initialEvidence = buildRouteSelectionEvidence(task, {
    outcome: input.outcome,
    now: input.now,
  });
  const [decision] = await sql<{ id: string }[]>`
    INSERT INTO decisions (
      hive_id, goal_id, task_id, title, context, recommendation, priority, status, kind, route_metadata
    )
    VALUES (
      ${task.hive_id}, ${task.goal_id}, ${task.id}, ${input.title},
      ${input.context}, ${input.recommendation}, ${input.priority},
      'ea_review', ${TRIAGE_DECISION_KIND}, ${sql.json(initialEvidence)}
    )
    RETURNING id
  `;
  if (!decision) return;

  const evidence = buildRouteSelectionEvidence(task, {
    outcome: input.outcome,
    now: input.now,
    decisionId: decision.id,
  });
  await persistTaskRouteSelectionEvidence(sql, task.id, evidence);
  await sql`
    UPDATE decisions
    SET route_metadata = ${sql.json(evidence)}
    WHERE id = ${decision.id}
  `;
}

function buildRouteSelectionEvidence(
  task: UnresolvableTaskRow,
  input: {
    outcome: UnresolvableTriageOutcome;
    now: Date;
    route?: { adapterType: string; modelId: string } | null;
    health?: ModelSpawnHealthDecision | null;
    decisionId?: string | null;
    spawnedTaskId?: string | null;
    supersedingTaskId?: string | null;
    fixTaskId?: string | null;
  },
): RouteSelectionEvidence {
  const route = input.route === undefined ? taskRoute(task) : input.route;
  const sourceConfidence = buildSourceConfidence(task, route);
  const executionConfidence = buildExecutionConfidence(input.health ?? null);
  const limitations = [
    "No retained trace package is attached to unresolvable triage routing evidence.",
    "No retained output package is attached to unresolvable triage routing evidence.",
    "No retained evaluation package is attached to unresolvable triage routing evidence.",
  ];

  return {
    schemaVersion: 1,
    outcome: input.outcome,
    route,
    health: input.health ? {
      canRun: input.health.canRun,
      status: input.health.status,
      reason: input.health.reason,
      failureReason: input.health.failureReason ?? null,
    } : null,
    context: {
      reason: task.failure_reason ?? "Unknown",
      sourceTaskId: task.id,
      timestamp: input.now.toISOString(),
    },
    links: {
      decisionId: input.decisionId ?? null,
      spawnedTaskId: input.spawnedTaskId ?? null,
      supersedingTaskId: input.supersedingTaskId ?? null,
      fixTaskId: input.fixTaskId ?? null,
    },
    source_confidence: sourceConfidence,
    execution_confidence: executionConfidence,
    legacy_evidence_confidence: minEvidenceConfidence(sourceConfidence, executionConfidence),
    packaging_schema_version: 1,
    provider: route ? providerForRuntime(route.adapterType) : null,
    runtime: route?.adapterType ?? null,
    trace_package_ref: {
      status: "not_available",
      reason: "No retained trace package is available for this triage-only evidence surface.",
    },
    output_package_ref: {
      status: "not_available",
      reason: "No retained output package is available for this triage-only evidence surface.",
    },
    evaluation_package_ref: {
      status: "not_available",
      reason: "No retained evaluation package is available for this triage-only evidence surface.",
    },
    capture_limitations: limitations,
  };
}

async function persistTaskRouteSelectionEvidence(
  sql: Sql,
  taskId: string,
  evidence: RouteSelectionEvidence,
): Promise<void> {
  await sql`
    UPDATE tasks
    SET route_selection_evidence = ${sql.json(evidence)},
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

function readRecordId(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function taskRoute(task: UnresolvableTaskRow): { adapterType: string; modelId: string } | null {
  const adapterType = (task.adapter_override ?? task.role_adapter_type)?.trim();
  const modelId = (task.model_override ?? task.model_used)?.trim();
  if (!adapterType || !modelId) return null;
  return { adapterType, modelId };
}

function buildSourceConfidence(
  task: UnresolvableTaskRow,
  route: { adapterType: string; modelId: string } | null,
): EvidenceConfidence {
  return task.failure_reason && route ? "medium" : "low";
}

function buildExecutionConfidence(
  health: ModelSpawnHealthDecision | null,
): EvidenceConfidence {
  return health ? "medium" : "low";
}

function minEvidenceConfidence(
  left: EvidenceConfidence,
  right: EvidenceConfidence,
): EvidenceConfidence {
  const rank: Record<EvidenceConfidence, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  return rank[left] <= rank[right] ? left : right;
}

function providerForRuntime(adapterType: string): string {
  const normalized = adapterType.trim().toLowerCase();
  if (normalized === "codex" || normalized.startsWith("openai")) return "openai";
  if (normalized === "claude-code" || normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("gemini")) return "google";
  if (normalized === "ollama" || normalized === "openclaw") return "local";
  return normalized;
}

function isRuntimeFailure(reason: string | null): boolean {
  if (!reason) return false;
  return [
    /^Codex exited code \d+/i,
    /^Claude exited code \d+/i,
    /^Process exited with code \d+/i,
    /^Process killed\b/i,
    /^Spawn failed\b/i,
    /^Spawn error\b/i,
    /^Failed to start session\b/i,
    /^Session send failed\b/i,
    /route unavailable/i,
    /model health/i,
    /health probe/i,
  ].some((pattern) => pattern.test(reason));
}

function isOwnerJudgementFailure(reason: string | null): boolean {
  if (!reason) return false;
  return /\b(owner|human)\b.*\b(input|decision|judg(e)?ment|approval|choose|choice)\b/i.test(reason) ||
    /\b(choose|choice|judg(e)?ment|approval)\b.*\b(owner|human)\b/i.test(reason);
}

function isEaReviewFailure(reason: string | null): boolean {
  if (!reason) return false;
  return /\b(credential|connector|permission|scope_denied|oauth|api key|subscription|account|governance|approval)\b/i.test(reason);
}
