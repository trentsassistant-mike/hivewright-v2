import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { getHiveResumeReadiness } from "@/hives/resume-readiness";
import { getHiveCreationPause } from "@/operations/creation-pause";
import type {
  FindingKind,
  FindingSeverity,
  HiveHealthMetrics,
  HiveHealthReport,
  HiveTargetContext,
  SupervisorFinding,
} from "./types";

/**
 * Stable finding id / dedupe key.
 *
 * The id produced here doubles as the dedupe key: `(hiveId, finding.id)`
 * uniquely identifies a finding across supervisor heartbeats, which the
 * applier's dedupe check + the supervisor_reports audit trail both rely
 * on. The layout follows the per-detector "Dedupe" conventions in
 * docs/superpowers/research/2026-04-21-hive-supervisor-baseline.md:
 *
 *   <kind>:<primary-ref>[:<discriminator>...]
 *
 * Given identical inputs this function returns the identical string —
 * detectors MUST funnel every finding id through it instead of
 * hand-rolling template literals, so format drift cannot split the same
 * real-world incident across two dedupe keys.
 */
export function findingId(
  kind: FindingKind,
  ...parts: Array<string>
): string {
  if (parts.length === 0) {
    throw new Error(
      `findingId(${kind}): at least one key component is required`,
    );
  }
  for (const p of parts) {
    if (p === undefined || p === null || p === "") {
      throw new Error(
        `findingId(${kind}): empty key component — finding ids must be fully specified`,
      );
    }
    if (p.includes(":")) {
      throw new Error(
        `findingId(${kind}): key component "${p}" contains ':' which is the id separator`,
      );
    }
  }
  return [kind, ...parts].join(":");
}

/**
 * Deterministic findings ordering, sorted in place:
 *   1. severity (critical → warn → info)
 *   2. kind (alphabetical) for stable grouping
 *   3. finding id (alphabetical) to fully break ties
 *
 * Exported so the scan core + tests can assert ordering without round-
 * tripping a HiveHealthReport through the DB. Given the same input array,
 * two invocations produce byte-identical output — that determinism is
 * what lets the supervisor_reports audit compare consecutive heartbeats.
 */
export function sortFindings(findings: SupervisorFinding[]): void {
  const rank: Record<FindingSeverity, number> = {
    critical: 0,
    warn: 1,
    info: 2,
  };
  findings.sort((a, b) => {
    const d = rank[a.severity] - rank[b.severity];
    if (d !== 0) return d;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Deterministic per-hive health scan. Produces a HiveHealthReport containing
 * structural metrics plus any detector findings that fire under
 * supervisor-baseline-v1 thresholds. Pure query work — no LLM calls, no side
 * effects. Given identical DB state the output is identical.
 *
 * Detector → query/signal basis (all six baselines):
 *   - stalled_task: tasks.status + last_heartbeat / started_at / updated_at
 *     + parent_task_id child check
 *   - aging_decision: decisions.status/priority/created_at/owner_response
 *     + decision_messages recency
 *   - recurring_failure: tasks.failure_reason normalized in-process,
 *     grouped by assigned_to + signature over the last 24 h
 *   - unsatisfied_completion: tasks completed>30m with substantive output
 *     (work_products OR result_summary≥200 chars) and no child/decision
 *   - dormant_goal: goals.status='active' with no open child tasks and
 *     GREATEST(goal/task/comment/document activity) older than 24 h
 *   - orphan_output: owner-direct completed tasks (parent_task_id IS NULL,
 *     goal_id IS NULL) joined to work_products, older than 30 min, no
 *     child/decision follow-up
 *
 * See docs/superpowers/research/2026-04-21-hive-supervisor-baseline.md for
 * the threshold + suppression rationale behind each detector.
 */
export async function scanHive(
  sql: Sql,
  hiveId: string,
): Promise<HiveHealthReport> {
  const [metrics, creationPause, targets] = await Promise.all([
    fetchMetrics(sql, hiveId),
    getHiveCreationPause(sql, hiveId),
    fetchTargetContext(sql, hiveId),
  ]);
  const resumeReadiness = await getHiveResumeReadiness(sql, {
    hiveId,
    creationPause,
  });
  const findings: SupervisorFinding[] = [];
  findings.push(...(await detectStalledTasks(sql, hiveId)));
  findings.push(...(await detectAgingDecisions(sql, hiveId)));
  findings.push(...(await detectRecurringFailures(sql, hiveId)));
  findings.push(...(await detectUnsatisfiedCompletions(sql, hiveId)));
  findings.push(...(await detectDormantGoals(sql, hiveId)));
  findings.push(...(await detectGoalLifecycleGaps(sql, hiveId)));
  findings.push(...(await detectOrphanOutputs(sql, hiveId)));
  sortFindings(findings);
  const report: HiveHealthReport = {
    hiveId,
    scannedAt: new Date().toISOString(),
    findings,
    metrics,
    operatingContext: {
      creationPause,
      resumeReadiness,
      targets,
    },
  };
  report.fingerprint = reportFingerprint(report);
  return report;
}

function reportFingerprint(report: HiveHealthReport): string {
  return createHash("sha256")
    .update(stableJson(materialReportState(report)))
    .digest("hex");
}

function materialReportState(report: HiveHealthReport): unknown {
  const context = report.operatingContext;
  return {
    hiveId: report.hiveId,
    metrics: report.metrics,
    findings: report.findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      ref: finding.ref,
    })),
    operatingContext: context
      ? {
          creationPause: {
            paused: context.creationPause.paused,
            operatingState: context.creationPause.operatingState,
            pausedScheduleIds: [...context.creationPause.pausedScheduleIds].sort(),
          },
          resumeReadiness: {
            status: context.resumeReadiness.status,
            canResumeSafely: context.resumeReadiness.canResumeSafely,
            counts: context.resumeReadiness.counts,
            models: {
              enabled: context.resumeReadiness.models.enabled,
              ready: context.resumeReadiness.models.ready,
              blocked: context.resumeReadiness.models.blocked,
              blockedRoutes: context.resumeReadiness.models.blockedRoutes
                .map((route) => ({
                  provider: route.provider,
                  adapterType: route.adapterType,
                  modelId: route.modelId,
                  canRun: route.canRun,
                  reason: route.reason,
                  status: route.status ?? null,
                  failureReason: route.failureReason ?? null,
                }))
                .sort((a, b) =>
                  `${a.provider}:${a.adapterType}:${a.modelId}`.localeCompare(
                    `${b.provider}:${b.adapterType}:${b.modelId}`,
                  ),
                ),
            },
            sessions: {
              persistentRoutes: context.resumeReadiness.sessions.persistentRoutes,
              fallbackRoutes: context.resumeReadiness.sessions.fallbackRoutes,
            },
            targets: {
              open: context.targets.open,
              achieved: context.targets.achieved,
              abandoned: context.targets.abandoned,
              overdueOpen: context.targets.overdueOpen,
              dueSoonOpen: context.targets.dueSoonOpen,
              openTargets: context.targets.openTargets.map((target) => ({
                id: target.id,
                title: target.title,
                targetValue: target.targetValue,
                deadline: target.deadline,
                sortOrder: target.sortOrder,
              })),
            },
            blockers: context.resumeReadiness.blockers
              .map((blocker) => ({
                code: blocker.code,
                count: blocker.count,
              }))
              .sort((a, b) => a.code.localeCompare(b.code)),
          },
        }
      : null,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

async function fetchTargetContext(
  sql: Sql,
  hiveId: string,
): Promise<HiveTargetContext> {
  const [counts] = await sql<
    Array<{
      open: number;
      achieved: number;
      abandoned: number;
      overdue_open: number;
      due_soon_open: number;
    }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE status = 'open')::int AS open,
      COUNT(*) FILTER (WHERE status = 'achieved')::int AS achieved,
      COUNT(*) FILTER (WHERE status = 'abandoned')::int AS abandoned,
      COUNT(*) FILTER (
        WHERE status = 'open'
          AND deadline IS NOT NULL
          AND deadline < CURRENT_DATE
      )::int AS overdue_open,
      COUNT(*) FILTER (
        WHERE status = 'open'
          AND deadline IS NOT NULL
          AND deadline >= CURRENT_DATE
          AND deadline <= CURRENT_DATE + 7
      )::int AS due_soon_open
    FROM hive_targets
    WHERE hive_id = ${hiveId}
  `;
  const openTargets = await sql<
    Array<{
      id: string;
      title: string;
      target_value: string | null;
      deadline: string | null;
      sort_order: number;
    }>
  >`
    SELECT
      id,
      title,
      target_value,
      deadline::text AS deadline,
      sort_order
    FROM hive_targets
    WHERE hive_id = ${hiveId}
      AND status = 'open'
    ORDER BY sort_order ASC, created_at ASC
    LIMIT 10
  `;
  return {
    open: counts.open,
    achieved: counts.achieved,
    abandoned: counts.abandoned,
    overdueOpen: counts.overdue_open,
    dueSoonOpen: counts.due_soon_open,
    openTargets: openTargets.map((target) => ({
      id: target.id,
      title: target.title,
      targetValue: target.target_value,
      deadline: target.deadline,
      sortOrder: target.sort_order,
    })),
  };
}

async function fetchMetrics(
  sql: Sql,
  hiveId: string,
): Promise<HiveHealthMetrics> {
  const [row] = await sql<
    Array<{
      open_tasks: number;
      active_goals: number;
      open_decisions: number;
      tasks_completed_24h: number;
      tasks_failed_24h: number;
    }>
  >`
    SELECT
      (
        SELECT COUNT(*)::int FROM tasks
        WHERE hive_id = ${hiveId}
          AND status IN ('pending','active','blocked','in_review')
      ) AS open_tasks,
      (
        SELECT COUNT(*)::int FROM goals
        WHERE hive_id = ${hiveId} AND status = 'active'
      ) AS active_goals,
      (
        SELECT COUNT(*)::int FROM decisions
        WHERE hive_id = ${hiveId} AND status = 'pending'
      ) AS open_decisions,
      (
        SELECT COUNT(*)::int FROM tasks
        WHERE hive_id = ${hiveId}
          AND status = 'completed'
          AND completed_at > NOW() - interval '24 hours'
      ) AS tasks_completed_24h,
      (
        SELECT COUNT(*)::int FROM tasks
        WHERE hive_id = ${hiveId}
          AND status IN ('failed','unresolvable')
          AND updated_at > NOW() - interval '24 hours'
      ) AS tasks_failed_24h
  `;
  return {
    openTasks: row.open_tasks,
    activeGoals: row.active_goals,
    openDecisions: row.open_decisions,
    tasksCompleted24h: row.tasks_completed_24h,
    tasksFailed24h: row.tasks_failed_24h,
  };
}

/**
 * stalled_task — baseline-v1:
 *   - active tasks with stale heartbeat > 20 min OR null heartbeat +
 *     started_at > 20 min → warn
 *   - active tasks whose total runtime exceeds 3 hours → critical
 *     (well past the 2h watchdog cap; the watchdog failed to remediate)
 *   - blocked/in_review tasks older than 6 hours with no pending/active
 *     child → warn (suppressed while a repair child is still running)
 */
async function detectStalledTasks(
  sql: Sql,
  hiveId: string,
): Promise<SupervisorFinding[]> {
  const rows = await sql<
    Array<{
      id: string;
      assigned_to: string;
      title: string;
      status: string;
      started_at: Date | null;
      last_heartbeat: Date | null;
      updated_at: Date;
      runtime_hours: number | null;
      hb_age_minutes: number | null;
    }>
  >`
    SELECT
      t.id, t.assigned_to, t.title, t.status,
      t.started_at, t.last_heartbeat, t.updated_at,
      EXTRACT(EPOCH FROM (NOW() - t.started_at)) / 3600 AS runtime_hours,
      CASE
        WHEN t.last_heartbeat IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (NOW() - t.last_heartbeat)) / 60
      END AS hb_age_minutes
    FROM tasks t
    WHERE t.hive_id = ${hiveId}
      AND (
        (
          t.status = 'active'
          AND (
            (t.last_heartbeat IS NOT NULL AND t.last_heartbeat < NOW() - interval '20 minutes')
            OR (t.last_heartbeat IS NULL AND t.started_at < NOW() - interval '20 minutes')
            OR (t.started_at < NOW() - interval '3 hours')
          )
        )
        OR (
          t.status IN ('blocked', 'in_review')
          AND t.updated_at < NOW() - interval '6 hours'
          AND NOT EXISTS (
            SELECT 1 FROM tasks c
            WHERE c.parent_task_id = t.id
              AND c.status IN ('pending', 'active')
          )
        )
      )
  `;
  return rows.map((row) => {
    let severity: FindingSeverity = "warn";
    if (
      row.status === "active" &&
      row.runtime_hours !== null &&
      row.runtime_hours >= 3
    ) {
      severity = "critical";
    }
    return {
      id: findingId("stalled_task", row.id, row.status),
      kind: "stalled_task",
      severity,
      ref: { taskId: row.id, role: row.assigned_to },
      summary: `Stalled ${row.status} task (${row.assigned_to}): "${row.title}"`,
      detail: {
        status: row.status,
        startedAt: row.started_at,
        lastHeartbeat: row.last_heartbeat,
        updatedAt: row.updated_at,
        runtimeHours:
          row.runtime_hours !== null ? Number(row.runtime_hours) : null,
        heartbeatAgeMinutes:
          row.hb_age_minutes !== null ? Number(row.hb_age_minutes) : null,
      },
    };
  });
}

/**
 * aging_decision — baseline-v1:
 *   - pending decision with priority='urgent' older than 4h and no
 *     decision_messages inside the last 4h → warn
 *   - pending decision with non-urgent priority older than 24h and no
 *     decision_messages inside the last 24h → warn
 *   - any qualifying decision older than 72h upgrades to critical
 *   Suppressions: non-pending status (ea_review/resolved/auto_approved) and
 *   decisions whose owner_response is already populated.
 */
async function detectAgingDecisions(
  sql: Sql,
  hiveId: string,
): Promise<SupervisorFinding[]> {
  const rows = await sql<
    Array<{
      id: string;
      title: string;
      priority: string;
      created_at: Date;
      age_hours: number;
    }>
  >`
    SELECT
      d.id, d.title, d.priority, d.created_at,
      EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 3600 AS age_hours
    FROM decisions d
    WHERE d.hive_id = ${hiveId}
      AND d.status = 'pending'
      AND d.owner_response IS NULL
      AND (
        (
          d.priority = 'urgent'
          AND d.created_at < NOW() - interval '4 hours'
          AND NOT EXISTS (
            SELECT 1 FROM decision_messages dm
            WHERE dm.decision_id = d.id
              AND dm.created_at > NOW() - interval '4 hours'
          )
        )
        OR (
          d.priority <> 'urgent'
          AND d.created_at < NOW() - interval '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM decision_messages dm
            WHERE dm.decision_id = d.id
              AND dm.created_at > NOW() - interval '24 hours'
          )
        )
      )
  `;
  return rows.map((row) => {
    const hours = Number(row.age_hours);
    const severity: FindingSeverity = hours >= 72 ? "critical" : "warn";
    return {
      id: findingId("aging_decision", row.id),
      kind: "aging_decision",
      severity,
      ref: { decisionId: row.id },
      summary: `Pending ${row.priority} decision aged ${hours.toFixed(1)}h: "${row.title}"`,
      detail: {
        priority: row.priority,
        createdAt: row.created_at,
        ageHours: hours,
      },
    };
  });
}

/**
 * Normalize a raw failure_reason into a stable grouping signature so that
 * the recurring_failure detector can cluster near-identical incidents that
 * differ only in runtime-variable pieces (UUIDs, epoch-ms timeouts, quoted
 * paths). Without this, one underlying outage produces N distinct strings
 * and no single cluster ever reaches the threshold.
 *
 * Rules, applied in order:
 *   1. UUIDs (8-4-4-4-12 hex) → <uuid>
 *   2. Quoted strings (single or double) → <str>
 *   3. Integer runs (including those glued to unit suffixes like "12000ms")
 *      → <n>
 *   4. Whitespace collapsed + trimmed
 */
export function normalizeFailureSignature(reason: string): string {
  return reason
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/"[^"]*"/g, "<str>")
    .replace(/'[^']*'/g, "<str>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

const TERMINAL_VERIFICATION_INTENT_RE =
  /\b(verify|verification|verifying|confirm|confirmation|check|recheck|smoke test|re-verify|reverify|validate|validation|audit)\b/i;

const TERMINAL_VERIFICATION_PROOF_ONLY_PATTERNS = [
  /\bdo not write code\b/i,
  /\bno code changes\b/i,
  /\bdo not modify any files\b/i,
  /\bdo not modify(?: application)? code\b/i,
  /\bdo not change(?: application)? code\b/i,
  /\bdo not change ui behavior\b/i,
  /\bdo not change behavior beyond\b/i,
  /\bdo not commit\b/i,
  /\breport only\b/i,
  /\bproduce a concise\b/i,
  /\bproduce a concrete\b/i,
  /\bimplementation checklist\b/i,
  /\bimplementation-ready matrix\b/i,
  /\bfile-referenced list\b/i,
];

const TERMINAL_VERIFICATION_IMPLEMENTATION_PATTERNS = [
  /\b(fix|implement|update|add|remove|commit|apply|write|create|delete|migrate|stage|edit|change|land|harden)\b/i,
  /\bif any remain\b/i,
  /\bif not committed\b/i,
  /\bif needed\b/i,
  /\bif unresolved\b/i,
  /\bapply the minimal fix\b/i,
  /\bmake only minimal follow-up edits\b/i,
  /\bupdate or add focused tests\b/i,
];

function matchesAnyPattern(
  text: string,
  patterns: readonly RegExp[],
): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Terminal verification tasks are structurally complete when the task is
 * explicitly scoped to proof/reporting only: verification intent is present,
 * the brief says "no code / no file changes" (or an equivalent report-only
 * deliverable), and there is no competing implementation cue such as
 * "fix it if needed" or "commit the change". A work_product alone does NOT
 * disqualify the task because many verification/audit tasks persist their
 * report as a markdown note; that artifact is the deliverable itself, not
 * proof that code work is still missing.
 *
 * This seam stays intentionally narrow. Verification-flavoured tasks that may
 * still need implementation remain eligible for unsatisfied_completion, which
 * preserves real unfinished-work findings like "verify X is committed; if not,
 * apply the fix and commit it".
 */
export function isTerminalVerificationTask(input: {
  title: string | null;
  brief: string | null;
  hasWorkProduct: boolean;
  failureReason: string | null;
}): boolean {
  return getTerminalVerificationDecision(input).eligible;
}

export function getTerminalVerificationDecision(input: {
  title: string | null;
  brief: string | null;
  hasWorkProduct: boolean;
  failureReason: string | null;
}): {
  eligible: boolean;
  verificationLike: boolean;
  proofOnly: boolean;
  implementationCue: boolean;
  hasWorkProduct: boolean;
  blockedByFailureReason: boolean;
} {
  const blockedByFailureReason = input.failureReason !== null;
  const text = [input.title ?? "", input.brief ?? ""].join("\n").trim();
  const verificationLike = TERMINAL_VERIFICATION_INTENT_RE.test(text);
  const proofOnly = matchesAnyPattern(
    text,
    TERMINAL_VERIFICATION_PROOF_ONLY_PATTERNS,
  );
  const implementationCue = matchesAnyPattern(
    text,
    TERMINAL_VERIFICATION_IMPLEMENTATION_PATTERNS,
  );
  return {
    eligible:
      !blockedByFailureReason
      && verificationLike
      && proofOnly
      && !implementationCue,
    verificationLike,
    proofOnly,
    implementationCue,
    hasWorkProduct: input.hasWorkProduct,
    blockedByFailureReason,
  };
}

function signatureHash(signature: string): string {
  return createHash("sha256")
    .update(signature)
    .digest("hex")
    .slice(0, 16);
}

/**
 * recurring_failure — baseline-v1:
 *   - same role + normalized failure signature appearing in ≥ 3 tasks
 *     within the last 24 h
 *   - excludes assigned_to='doctor' and dev tasks whose title starts with
 *     '[Doctor] Diagnose:' (doctor-recursion descendants) to avoid
 *     resurfacing the 2026-04-16 doctor-loop incident
 *   - mixes status='failed' and 'unresolvable' because both represent
 *     terminal failures from the role's perspective
 *   - severity is always critical: 3 identical failures in a day is a
 *     real incident, not a threshold to tune by count
 */
async function detectRecurringFailures(
  sql: Sql,
  hiveId: string,
): Promise<SupervisorFinding[]> {
  const rows = await sql<
    Array<{
      id: string;
      assigned_to: string;
      failure_reason: string;
    }>
  >`
    SELECT t.id, t.assigned_to, t.failure_reason
    FROM tasks t
    WHERE t.hive_id = ${hiveId}
      AND t.status IN ('failed', 'unresolvable')
      AND t.failure_reason IS NOT NULL
      AND t.created_at > NOW() - interval '24 hours'
      AND t.assigned_to <> 'doctor'
      AND t.title NOT LIKE '[Doctor] Diagnose:%'
  `;
  const groups = new Map<
    string,
    { role: string; signature: string; taskIds: string[] }
  >();
  for (const row of rows) {
    const signature = normalizeFailureSignature(row.failure_reason);
    if (!signature) continue;
    const key = `${row.assigned_to} ${signature}`;
    const existing = groups.get(key);
    if (existing) {
      existing.taskIds.push(row.id);
    } else {
      groups.set(key, {
        role: row.assigned_to,
        signature,
        taskIds: [row.id],
      });
    }
  }
  const taskIdsWithDiagnostics = rows.map((row) => row.id);
  const diagnosticByTaskId = new Map<
    string,
    {
      codexEmptyOutput: boolean;
      rolloutSignaturePresent: boolean;
      effectiveAdapter: string | null;
      adapterOverride: string | null;
      modelSlug: string | null;
      modelProviderMismatchDetected: boolean;
    }
  >();
  if (taskIdsWithDiagnostics.length > 0) {
    const diagnosticRows = await sql<
      Array<{
        task_id: string;
        codex_empty_output: boolean | null;
        rollout_signature_present: boolean | null;
        effective_adapter: string | null;
        adapter_override: string | null;
        model_slug: string | null;
        model_provider_mismatch_detected: boolean | null;
      }>
    >`
      SELECT DISTINCT ON (task_id)
        task_id,
        (chunk::jsonb ->> 'codexEmptyOutput')::boolean AS codex_empty_output,
        (chunk::jsonb ->> 'rolloutSignaturePresent')::boolean AS rollout_signature_present,
        chunk::jsonb ->> 'effectiveAdapter' AS effective_adapter,
        chunk::jsonb ->> 'adapterOverride' AS adapter_override,
        chunk::jsonb ->> 'modelSlug' AS model_slug,
        (chunk::jsonb ->> 'modelProviderMismatchDetected')::boolean AS model_provider_mismatch_detected
      FROM task_logs
      WHERE task_id = ANY(${taskIdsWithDiagnostics}::uuid[])
        AND type = 'diagnostic'
        AND chunk::jsonb ->> 'kind' = 'codex_empty_output'
      ORDER BY task_id, id DESC
    `;
    for (const row of diagnosticRows) {
      diagnosticByTaskId.set(row.task_id, {
        codexEmptyOutput: row.codex_empty_output === true,
        rolloutSignaturePresent: row.rollout_signature_present === true,
        effectiveAdapter: row.effective_adapter,
        adapterOverride: row.adapter_override,
        modelSlug: row.model_slug,
        modelProviderMismatchDetected: row.model_provider_mismatch_detected === true,
      });
    }
  }
  const findings: SupervisorFinding[] = [];
  for (const { role, signature, taskIds } of groups.values()) {
    if (taskIds.length < 3) continue;
    const hash = signatureHash(signature);
    const sortedIds = [...taskIds].sort();
    const diagnosticTaskIds = sortedIds.filter((taskId) => diagnosticByTaskId.has(taskId));
    const codexEmptyOutput = diagnosticTaskIds.some(
      (taskId) => diagnosticByTaskId.get(taskId)?.codexEmptyOutput === true,
    );
    const rolloutSignaturePresent = diagnosticTaskIds.some(
      (taskId) => diagnosticByTaskId.get(taskId)?.rolloutSignaturePresent === true,
    );
    const diagnosticModels = Array.from(new Set(
      diagnosticTaskIds
        .map((taskId) => diagnosticByTaskId.get(taskId)?.modelSlug)
        .filter((value): value is string => Boolean(value)),
    )).sort();
    const diagnosticEffectiveAdapters = Array.from(new Set(
      diagnosticTaskIds
        .map((taskId) => diagnosticByTaskId.get(taskId)?.effectiveAdapter)
        .filter((value): value is string => Boolean(value)),
    )).sort();
    const diagnosticAdapterOverrides = Array.from(new Set(
      diagnosticTaskIds
        .map((taskId) => diagnosticByTaskId.get(taskId)?.adapterOverride)
        .filter((value): value is string => Boolean(value)),
    )).sort();
    const modelProviderMismatchDetected = diagnosticTaskIds.some(
      (taskId) => diagnosticByTaskId.get(taskId)?.modelProviderMismatchDetected === true,
    );
    findings.push({
      id: findingId("recurring_failure", role, hash),
      kind: "recurring_failure",
      severity: "critical",
      ref: { role },
      summary: `Recurring failure on ${role} (${taskIds.length} in 24h): ${signature.slice(0, 120)}`,
      detail: {
        role,
        signature,
        signatureHash: hash,
        count: taskIds.length,
        taskIds: sortedIds,
        codexEmptyOutput,
        rolloutSignaturePresent,
        diagnosticTaskIds,
        diagnosticModels,
        diagnosticEffectiveAdapters,
        diagnosticAdapterOverrides,
        modelProviderMismatchDetected,
      },
    });
  }
  return findings;
}

/**
 * unsatisfied_completion — baseline-v1 + integrity-violation path:
 *   Shared gates (both paths): status='completed', role is NOT terminal
 *   (role_templates.terminal = false AND role NOT IN the hardcoded
 *   qa/doctor/goal-supervisor/hive-supervisor safety set), no child
 *   task, no linked decision. Terminal roles produce single-turn
 *   outputs that don't imply pending follow-up: QA verdicts, doctor
 *   diagnoses, analysis-only commentary (research-analyst /
 *   design-agent), and the hive-supervisor's own heartbeats. A
 *   follow-up child or decision means someone already acted on the
 *   output.
 *
 *   Path A — silent-deadend delivery:
 *     - direct (goal_id IS NULL) task completed > 30 min ago
 *     - with evidence of substantive output: either a work_products row
 *       or a result_summary ≥ 200 chars — short summaries are not
 *       enough signal
 *
 *   Path B — integrity violation (completed rows with failure metadata):
 *     - failure_reason IS NOT NULL
 *     - goal-owned rows are NOT suppressed: the goal supervisor has been
 *       observed accepting turn-limit "completions" without noticing the
 *       failure_reason (see incident on goal 168360bb / task 6de38eb2)
 *     - no 30-min age gate and no output-thickness gate: the presence of
 *       failure_reason IS the signal, not the output body
 *
 *   severity: warn for both paths (unsatisfied_completion is the
 *   riskiest detector for false positives per baseline, so we stay
 *   cautious on severity and let the LLM judge).
 *
 *   The hive-supervisor self-scan exclusion is belt-and-braces:
 *   role_templates.terminal=true already suppresses it, AND the
 *   hardcoded slug is listed so a bad role-library sync or a
 *   terminal=false regression cannot re-introduce the 2026-04-22
 *   false-positive loop (heartbeat tasks flagging each other).
 */
async function detectUnsatisfiedCompletions(
  sql: Sql,
  hiveId: string,
): Promise<SupervisorFinding[]> {
  const rows = await sql<
    Array<{
      id: string;
      assigned_to: string;
      title: string;
      brief: string;
      completed_at: Date;
      result_summary: string | null;
      failure_reason: string | null;
      has_work_product: boolean;
    }>
  >`
    SELECT
      t.id, t.assigned_to, t.title, t.brief, t.completed_at, t.result_summary,
      t.failure_reason,
      EXISTS (SELECT 1 FROM work_products wp WHERE wp.task_id = t.id) AS has_work_product
    FROM tasks t
    WHERE t.hive_id = ${hiveId}
      AND t.status = 'completed'
      AND t.assigned_to NOT IN ('qa', 'doctor', 'goal-supervisor', 'hive-supervisor')
      AND NOT EXISTS (
        SELECT 1 FROM role_templates rt
        WHERE rt.slug = t.assigned_to AND rt.terminal = true
      )
      AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id)
      -- Age cap: anything completed more than 7 days ago is stale noise.
      -- Without this cap the same terminal tasks fire forever and the
      -- agent re-derives the same noop every 15 min. Doctor and the
      -- regular failure path already cover anything actionable inside
      -- the 7-day window.
      AND t.completed_at > NOW() - interval '7 days'
      -- Recently-addressed suppression: if a supervisor report in the
      -- last 24h already addressed this finding (regardless of which
      -- action it picked), don't re-emit. Spawn/decision actions are
      -- already filtered above by the child/decision EXISTS checks;
      -- this catches the noop + log_insight case where the agent has
      -- already classified the finding as terminal noise. Cuts the
      -- wasted-LLM-cost loop where the supervisor reasons about the
      -- same Plan 4 smoke test 96 times a day.
      AND NOT EXISTS (
        SELECT 1 FROM supervisor_reports r
        WHERE r.hive_id = ${hiveId}
          AND r.ran_at > NOW() - interval '24 hours'
          AND r.actions IS NOT NULL
          AND r.actions->'findings_addressed' @> to_jsonb('unsatisfied_completion:' || t.id::text)
      )
      AND (
        (
          t.goal_id IS NULL
          AND t.completed_at < NOW() - interval '30 minutes'
          AND (
            EXISTS (SELECT 1 FROM work_products wp WHERE wp.task_id = t.id)
            OR COALESCE(length(t.result_summary), 0) >= 200
          )
        )
        OR t.failure_reason IS NOT NULL
      )
  `;
  return rows
    .filter(
      (row) =>
        !isTerminalVerificationTask({
          title: row.title,
          brief: row.brief,
          hasWorkProduct: row.has_work_product,
          failureReason: row.failure_reason,
        }),
    )
    .map((row) => ({
      id: findingId("unsatisfied_completion", row.id),
      kind: "unsatisfied_completion",
      severity: "warn" as FindingSeverity,
      ref: { taskId: row.id, role: row.assigned_to },
      summary: row.failure_reason
        ? `Completed ${row.assigned_to} task carrying failure_reason: "${row.title}"`
        : `Completed ${row.assigned_to} task with no follow-up: "${row.title}"`,
      detail: {
        completedAt: row.completed_at,
        hasWorkProduct: row.has_work_product,
        resultSummaryLength: row.result_summary?.length ?? 0,
        failureReason: row.failure_reason,
      },
    }));
}

/**
 * dormant_goal — baseline-v1:
 *   - goals.status='active' with no open child tasks (pending/active/
 *     blocked/in_review) AND latest activity across the goal itself,
 *     its tasks, its comments, and its documents older than 24 h
 *   - suppress the startup window: newly-created goal (< 1 h) with null
 *     session_id is mid-initialization, not dormant
 *   - Goal supervisor already wakes on settled sprints + owner comments;
 *     this detector catches goals those mechanisms have silently dropped
 */
async function detectDormantGoals(
  sql: Sql,
  hiveId: string,
): Promise<SupervisorFinding[]> {
  const rows = await sql<
    Array<{
      id: string;
      title: string;
      last_progress_at: Date;
      hours_since_progress: number;
      latest_initiative_run_id: string | null;
      latest_initiative_action_taken: string | null;
      latest_initiative_suppression_reason: string | null;
    }>
  >`
    SELECT
      g.id, g.title,
      GREATEST(
        g.updated_at,
        COALESCE((SELECT MAX(t.updated_at) FROM tasks t WHERE t.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
      ) AS last_progress_at,
      EXTRACT(EPOCH FROM (NOW() - GREATEST(
        g.updated_at,
        COALESCE((SELECT MAX(t.updated_at) FROM tasks t WHERE t.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
      ))) / 3600 AS hours_since_progress,
      latest_initiative.run_id AS latest_initiative_run_id,
      latest_initiative.action_taken AS latest_initiative_action_taken,
      latest_initiative.suppression_reason AS latest_initiative_suppression_reason
    FROM goals g
    LEFT JOIN LATERAL (
      SELECT d.run_id, d.action_taken, d.suppression_reason
      FROM initiative_run_decisions d
      JOIN initiative_runs r ON r.id = d.run_id
      WHERE d.hive_id = ${hiveId}
        AND d.candidate_ref = g.id::text
      ORDER BY r.started_at DESC, d.created_at DESC
      LIMIT 1
    ) latest_initiative ON TRUE
    WHERE g.hive_id = ${hiveId}
      AND g.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.goal_id = g.id
          AND t.status IN ('pending', 'active', 'blocked', 'in_review')
      )
      AND NOT (g.session_id IS NULL AND g.created_at > NOW() - interval '1 hour')
      AND GREATEST(
        g.updated_at,
        COALESCE((SELECT MAX(t.updated_at) FROM tasks t WHERE t.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
      ) < NOW() - interval '24 hours'
  `;
  return rows.map((row) => {
    const hours = Number(row.hours_since_progress);
    return {
      id: findingId("dormant_goal", row.id),
      kind: "dormant_goal",
      severity: "warn" as FindingSeverity,
      ref: { goalId: row.id },
      summary: `Dormant active goal (${hours.toFixed(1)}h since any activity): "${row.title}"`,
      detail: {
        lastProgressAt: row.last_progress_at,
        hoursSinceProgress: hours,
        initiative:
          row.latest_initiative_run_id !== null
            ? {
                latestSuppression:
                  row.latest_initiative_action_taken === "suppress"
                  && row.latest_initiative_suppression_reason !== null
                    ? {
                        runId: row.latest_initiative_run_id,
                        actionTaken: row.latest_initiative_action_taken,
                        suppressionReason: row.latest_initiative_suppression_reason,
                      }
                    : null,
              }
            : null,
      },
    };
  });
}

/**
 * goal_lifecycle_gap — faster active-goal lifecycle watchdog:
 *   - active goal with zero tasks after the 1h startup window
 *   - active goal with completed work but no next runnable task or closure
 *   - active goal whose tasks are all terminal and no next action exists
 *
 * This intentionally covers the gap before the 24h dormant-goal detector.
 * It is detection-only; the action planner still decides whether to wake,
 * close, log, or ask the EA for a bounded decision.
 */
async function detectGoalLifecycleGaps(
  sql: Sql,
  hiveId: string,
): Promise<SupervisorFinding[]> {
  const rows = await sql<
    Array<{
      id: string;
      title: string;
      created_at: Date;
      updated_at: Date;
      session_id: string | null;
      task_count: number;
      open_task_count: number;
      completed_task_count: number;
      latest_task_updated_at: Date | null;
      latest_completed_at: Date | null;
      latest_comment_at: Date | null;
      latest_document_at: Date | null;
      hours_since_created: number;
      hours_since_latest_activity: number;
    }>
  >`
    SELECT
      g.id,
      g.title,
      g.created_at,
      g.updated_at,
      g.session_id,
      COALESCE(task_stats.task_count, 0)::int AS task_count,
      COALESCE(task_stats.open_task_count, 0)::int AS open_task_count,
      COALESCE(task_stats.completed_task_count, 0)::int AS completed_task_count,
      task_stats.latest_task_updated_at,
      task_stats.latest_completed_at,
      comment_stats.latest_comment_at,
      document_stats.latest_document_at,
      EXTRACT(EPOCH FROM (NOW() - g.created_at)) / 3600 AS hours_since_created,
      EXTRACT(EPOCH FROM (
        NOW() - GREATEST(
          g.updated_at,
          COALESCE(task_stats.latest_task_updated_at, g.updated_at),
          COALESCE(comment_stats.latest_comment_at, g.updated_at),
          COALESCE(document_stats.latest_document_at, g.updated_at)
        )
      )) / 3600 AS hours_since_latest_activity
    FROM goals g
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS task_count,
        COUNT(*) FILTER (
          WHERE status IN ('pending', 'active', 'running', 'claimed', 'blocked', 'in_review')
        )::int AS open_task_count,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_task_count,
        MAX(updated_at) AS latest_task_updated_at,
        MAX(completed_at) FILTER (WHERE status = 'completed') AS latest_completed_at
      FROM tasks t
      WHERE t.goal_id = g.id
    ) task_stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT MAX(created_at) AS latest_comment_at
      FROM goal_comments gc
      WHERE gc.goal_id = g.id
    ) comment_stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT MAX(updated_at) AS latest_document_at
      FROM goal_documents gd
      WHERE gd.goal_id = g.id
    ) document_stats ON TRUE
    WHERE g.hive_id = ${hiveId}
      AND g.status = 'active'
      AND NOT (g.session_id IS NULL AND g.created_at > NOW() - interval '1 hour')
      AND COALESCE(task_stats.open_task_count, 0) = 0
      AND GREATEST(
        g.updated_at,
        COALESCE(task_stats.latest_task_updated_at, g.updated_at),
        COALESCE(comment_stats.latest_comment_at, g.updated_at),
        COALESCE(document_stats.latest_document_at, g.updated_at)
      ) > NOW() - interval '24 hours'
  `;

  const findings: SupervisorFinding[] = [];
  for (const row of rows) {
    const latestCommentAt = row.latest_comment_at?.getTime() ?? 0;
    const latestDocumentAt = row.latest_document_at?.getTime() ?? 0;
    const latestCompletedAt = row.latest_completed_at?.getTime() ?? 0;
    const recentNonTaskActivity =
      latestCommentAt > Date.now() - 30 * 60 * 1000 ||
      latestDocumentAt > Date.now() - 30 * 60 * 1000;
    const nonTaskActivityAfterCompletion =
      latestCompletedAt > 0 &&
      (latestCommentAt > latestCompletedAt || latestDocumentAt > latestCompletedAt);

    let reason: "no_tasks" | "completed_no_closure" | "no_next_action" | null = null;
    if (row.task_count === 0 && Number(row.hours_since_created) >= 1 && !recentNonTaskActivity) {
      reason = "no_tasks";
    } else if (
      row.completed_task_count > 0 &&
      row.latest_completed_at !== null &&
      row.latest_completed_at.getTime() < Date.now() - 30 * 60 * 1000 &&
      !nonTaskActivityAfterCompletion
    ) {
      reason = "completed_no_closure";
    } else if (
      row.task_count > 0 &&
      row.completed_task_count === 0 &&
      Number(row.hours_since_latest_activity) >= 2 &&
      !recentNonTaskActivity
    ) {
      reason = "no_next_action";
    }

    if (!reason) continue;

    findings.push({
      id: findingId("goal_lifecycle_gap", row.id, reason),
      kind: "goal_lifecycle_gap",
      severity: "warn",
      ref: { goalId: row.id },
      summary:
        reason === "no_tasks"
          ? `Active goal has no tasks after startup window: "${row.title}"`
          : reason === "completed_no_closure"
            ? `Active goal has completed work but no next action or closure: "${row.title}"`
            : `Active goal has no runnable work and no clear next action: "${row.title}"`,
      detail: {
        reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        taskCount: row.task_count,
        openTaskCount: row.open_task_count,
        completedTaskCount: row.completed_task_count,
        latestTaskUpdatedAt: row.latest_task_updated_at,
        latestCompletedAt: row.latest_completed_at,
        latestCommentAt: row.latest_comment_at,
        latestDocumentAt: row.latest_document_at,
        hoursSinceCreated: Number(row.hours_since_created),
        hoursSinceLatestActivity: Number(row.hours_since_latest_activity),
      },
    });
  }
  return findings;
}

/**
 * orphan_output — baseline-v1:
 *   - owner-direct (parent_task_id IS NULL, goal_id IS NULL) completed
 *     task older than 30 min that emitted at least one work_products row
 *   - no child task and no linked decision (nothing consumed the output)
 *   - excludes roles marked role_templates.terminal=true
 *     (analysis/commentary/watchdog roles whose work_products are the
 *     deliverable itself, not a prompt for more action) plus the
 *     hardcoded qa/doctor/goal-supervisor/hive-supervisor safety set
 *     so a role-library regression cannot re-introduce the self-scan
 *     loop. Also excludes the two title shapes that emit work_products
 *     by design but intentionally end there ('[QA] Review:%' and
 *     'Fix environment for:%').
 *   - severity: info — these are advisory-looking deliverables, genuinely
 *     ambiguous; the LLM decides whether a follow-up is warranted
 */
async function detectOrphanOutputs(
  sql: Sql,
  hiveId: string,
): Promise<SupervisorFinding[]> {
  const rows = await sql<
    Array<{
      id: string;
      assigned_to: string;
      title: string;
      completed_at: Date;
      work_product_count: number;
    }>
  >`
    SELECT
      t.id, t.assigned_to, t.title, t.completed_at,
      (SELECT COUNT(*)::int FROM work_products wp WHERE wp.task_id = t.id) AS work_product_count
    FROM tasks t
    WHERE t.hive_id = ${hiveId}
      AND t.status = 'completed'
      AND t.goal_id IS NULL
      AND t.parent_task_id IS NULL
      AND t.completed_at < NOW() - interval '30 minutes'
      -- Age cap: matches unsatisfied_completion. Anything older than
      -- 7 days is stale; without this cap orphan tasks fired forever
      -- (production saw 14-day-old findings still being re-processed
      -- every 15 min on 2026-04-22).
      AND t.completed_at > NOW() - interval '7 days'
      AND t.assigned_to NOT IN ('qa', 'doctor', 'goal-supervisor', 'hive-supervisor')
      AND NOT EXISTS (
        SELECT 1 FROM role_templates rt
        WHERE rt.slug = t.assigned_to AND rt.terminal = true
      )
      AND t.title NOT LIKE '[QA] Review:%'
      AND t.title NOT LIKE 'Fix environment for:%'
      AND EXISTS (SELECT 1 FROM work_products wp WHERE wp.task_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id)
      -- Recently-addressed suppression: same logic as unsatisfied_completion.
      -- Once a supervisor pass within 24h has addressed this finding via
      -- noop / log_insight (the "I've already classified this as terminal"
      -- case), don't re-emit. Spawn / decision actions self-suppress
      -- via the child/decision EXISTS checks above.
      AND NOT EXISTS (
        SELECT 1 FROM supervisor_reports r
        WHERE r.hive_id = ${hiveId}
          AND r.ran_at > NOW() - interval '24 hours'
          AND r.actions IS NOT NULL
          AND r.actions->'findings_addressed' @> to_jsonb('orphan_output:' || t.id::text)
      )
  `;
  return rows.map((row) => ({
    id: findingId("orphan_output", row.id),
    kind: "orphan_output",
    severity: "info" as FindingSeverity,
    ref: { taskId: row.id, role: row.assigned_to },
    summary: `Orphan output from ${row.assigned_to}: "${row.title}"`,
    detail: {
      completedAt: row.completed_at,
      workProductCount: row.work_product_count,
    },
  }));
}
