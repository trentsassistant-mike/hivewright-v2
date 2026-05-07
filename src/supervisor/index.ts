/**
 * Hive Supervisor barrel — exposes the full runSupervisor heartbeat entry
 * point plus the parse/apply/escalate primitives it composes over.
 *
 * runSupervisor is the single call site for the heartbeat schedule: it
 * runs a deterministic scan, short-circuits when nothing is wrong (no LLM
 * invocation, no audit row), otherwise persists an audit row, invokes the
 * supervisor agent, and routes the structured output through parse →
 * apply → persist outcomes. Mirrors the doctor pattern: pure-code work
 * brackets a single LLM turn.
 */
import type { JSONValue, Sql } from "postgres";
import { scanHive } from "./scan";
import { parseSupervisorActions } from "./parse-actions";
import { applySupervisorActions } from "./apply-actions";
import { escalateMalformedSupervisorOutput } from "./escalate";
import { reconcileUnresolvableTasks } from "./unresolvable-triage";
import type { AppliedOutcome, HiveHealthReport, SupervisorActions } from "./types";
import { normalizeBillableUsage } from "@/usage/billable-usage";

export { parseSupervisorActions } from "./parse-actions";
export { applySupervisorActions } from "./apply-actions";
export {
  escalateMalformedSupervisorOutput,
  type MalformedSupervisorEscalation,
} from "./escalate";
export { scanHive } from "./scan";
export { reconcileUnresolvableTasks } from "./unresolvable-triage";
export type {
  AppliedOutcome,
  AppliedStatus,
  FindingKind,
  FindingSeverity,
  HiveHealthMetrics,
  HiveHealthReport,
  ParseSupervisorActionsResult,
  SupervisorAction,
  SupervisorActionKind,
  SupervisorActions,
  SupervisorFinding,
  SupervisorFindingRef,
} from "./types";

export interface InvokeSupervisorAgentInput {
  hiveId: string;
  reportId: string;
  report: HiveHealthReport;
}

export interface InvokeSupervisorAgentResult {
  /**
   * Raw agent output. Empty string signals "agent was enqueued but has not
   * produced output yet" — runSupervisor leaves the supervisor_reports
   * row in a partially-populated state (actions/outcomes NULL) and the
   * dispatcher's task-completion hook fills it in later.
   */
  output: string;
  taskId?: string | null;
  freshInputTokens?: number | null;
  cachedInputTokens?: number | null;
  cachedInputTokensKnown?: boolean | null;
  totalContextTokens?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  estimatedBillableCostCents?: number | null;
  costCents?: number | null;
}

export type InvokeSupervisorAgent = (
  input: InvokeSupervisorAgentInput,
) => Promise<InvokeSupervisorAgentResult>;

export interface RunSupervisorOptions {
  /**
   * Agent invocation strategy. Tests inject a synchronous mock that
   * returns hard-coded agent output so the full parse/apply/persist flow
   * runs in-band. Production omits this and uses the default enqueue-a-
   * task path; the dispatcher's completion hook picks up the output later.
   */
  invokeAgent?: InvokeSupervisorAgent;
}

export interface RunSupervisorResult {
  /** True when the scan produced zero findings and the LLM was not invoked. */
  skipped: boolean;
  /** supervisor_reports row id — null only when skipped. */
  reportId: string | null;
  findings: number;
  actionsApplied: number;
  actionsSkipped: number;
  actionsErrored: number;
  /** True when agent output was malformed and escalated to EA review. */
  malformed?: boolean;
  /** True when agent output was empty (deferred apply). */
  deferred?: boolean;
  /** Terminal unresolvable task rows reconciled before the health scan. */
  unresolvableTriaged?: number;
}

export interface RunSupervisorDigestResult {
  skipped: false;
  reportId: string;
  findings: number;
  summary: string;
}

export interface FinalizeDeferredReportInput {
  /** The completed hive-supervisor task id — the dispatcher's completion hook passes this through. */
  taskId: string;
  /** Hive scope — must match the supervisor_reports row's hive_id (applier also scopes to it). */
  hiveId: string;
  /** Full stdout from the completed agent. Parsed for the fenced ```json block. */
  agentOutput: string;
}

export type FinalizeDeferredReportStatus =
  | "no_report_row"
  | "already_finalized"
  | "empty_output"
  | "applied"
  | "malformed";

export interface FinalizeDeferredReportResult {
  status: FinalizeDeferredReportStatus;
  reportId?: string;
  actionsApplied?: number;
  actionsSkipped?: number;
  actionsErrored?: number;
  reason?: string;
}

function toJsonValue(value: unknown): JSONValue {
  // The supervisor payloads can contain Date instances in nested detail fields.
  // Round-trip through JSON at the DB boundary so sql.json receives an actual
  // JSONValue shape instead of a wider TypeScript object graph.
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

/**
 * Heartbeat entry point. Short-circuits cheaply when the scan is clean
 * (no row written, no LLM call), otherwise persists an audit row up-front
 * so a crashing agent still leaves a trail, invokes the supervisor agent,
 * and routes its structured output through parse → apply → persist.
 *
 * Malformed output escalates via escalateMalformedSupervisorOutput
 * (ea_review, never pending — the EA buffer is the governance contract).
 */
export async function runSupervisor(
  sql: Sql,
  hiveId: string,
  opts: RunSupervisorOptions = {},
): Promise<RunSupervisorResult> {
  const unresolvableTriage = await reconcileUnresolvableTasks(sql, hiveId);
  const report = await scanHive(sql, hiveId);

  if (report.findings.length === 0) {
    return {
      skipped: true,
      reportId: null,
      findings: 0,
      actionsApplied: 0,
      actionsSkipped: 0,
      actionsErrored: 0,
      unresolvableTriaged: unresolvableTriage.touched,
    };
  }

  if (await latestReportCoversSameScan(sql, hiveId, report)) {
    return {
      skipped: true,
      reportId: null,
      findings: report.findings.length,
      actionsApplied: 0,
      actionsSkipped: 0,
      actionsErrored: 0,
      unresolvableTriaged: unresolvableTriage.touched,
    };
  }

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO supervisor_reports (hive_id, report)
    VALUES (${hiveId}, ${sql.json(toJsonValue(report))})
    RETURNING id
  `;
  const reportId = row.id;

  const invokeAgent = opts.invokeAgent ?? defaultInvokeAgent(sql);
  const agentResult = await invokeAgent({ hiveId, reportId, report });

  await persistAgentMetadata(sql, reportId, agentResult);

  if (!agentResult.output || agentResult.output.trim() === "") {
    return {
      skipped: false,
      reportId,
      findings: report.findings.length,
      actionsApplied: 0,
      actionsSkipped: 0,
      actionsErrored: 0,
      deferred: true,
      unresolvableTriaged: unresolvableTriage.touched,
    };
  }

  const parsed = parseSupervisorActions(agentResult.output);
  if (!parsed.ok) {
    await escalateMalformedSupervisorOutput(sql, {
      hiveId,
      reportId,
      reason: parsed.error,
      rawOutput: agentResult.output,
    });
    return {
      skipped: false,
      reportId,
      findings: report.findings.length,
      actionsApplied: 0,
      actionsSkipped: 0,
      actionsErrored: 0,
      malformed: true,
      unresolvableTriaged: unresolvableTriage.touched,
    };
  }

  const gatedActions = await enforceHeartbeatProceduralGates(sql, {
    hiveId,
    reportId,
    report,
    actions: parsed.value,
  });
  const outcomes = await applySupervisorActions(sql, hiveId, gatedActions, {
    report,
  });
  await persistActions(sql, reportId, gatedActions, outcomes);

  return {
    skipped: false,
    reportId,
    findings: report.findings.length,
    actionsApplied: countOutcomes(outcomes, "applied"),
    actionsSkipped: countOutcomes(outcomes, "skipped"),
    actionsErrored: countOutcomes(outcomes, "error"),
    unresolvableTriaged: unresolvableTriage.touched,
  };
}

async function latestReportCoversSameScan(
  sql: Sql,
  hiveId: string,
  report: HiveHealthReport,
): Promise<boolean> {
  const fingerprint = report.fingerprint;
  if (!fingerprint) return false;
  const [row] = await sql<Array<{
    fingerprint: string | null;
    scan_only_covered: boolean;
    open_deferred_agent_task: boolean;
    finding_ids: string[] | null;
  }>>`
    SELECT
      report->>'fingerprint' AS fingerprint,
      (
        agent_task_id IS NULL
        AND actions IS NOT NULL
        AND COALESCE(jsonb_array_length(actions->'actions'), 0) = 0
      ) AS scan_only_covered,
      (
        supervisor_reports.agent_task_id IS NOT NULL
        AND supervisor_reports.actions IS NULL
        AND tasks.status IN ('pending', 'active', 'claimed', 'running', 'in_review')
      ) AS open_deferred_agent_task,
      ARRAY(
        SELECT finding.value->>'id'
        FROM jsonb_array_elements(supervisor_reports.report->'findings')
          WITH ORDINALITY AS finding(value, ord)
        ORDER BY finding.ord
      ) AS finding_ids
    FROM supervisor_reports
    LEFT JOIN tasks ON tasks.id = supervisor_reports.agent_task_id
    WHERE supervisor_reports.hive_id = ${hiveId}
    ORDER BY supervisor_reports.ran_at DESC
    LIMIT 1
  `;
  if (!row) return false;
  if (row.scan_only_covered === true && row.fingerprint === fingerprint) {
    return true;
  }
  return (
    row.open_deferred_agent_task === true &&
    sameStringArray(row.finding_ids, report.findings.map((finding) => finding.id))
  );
}

function sameStringArray(left: string[] | null | undefined, right: string[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export async function runSupervisorDigest(
  sql: Sql,
  hiveId: string,
): Promise<RunSupervisorDigestResult> {
  const report = await scanHive(sql, hiveId);
  const actions: SupervisorActions = {
    summary: summarizeDigest(report),
    findings_addressed: report.findings.map((finding) => finding.id),
    actions: [],
  };

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO supervisor_reports (
      hive_id, report, actions, action_outcomes, cost_cents
    )
    VALUES (
      ${hiveId},
      ${sql.json(toJsonValue(report))},
      ${sql.json(toJsonValue(actions))},
      ${sql.json([])},
      0
    )
    RETURNING id
  `;

  return {
    skipped: false,
    reportId: row.id,
    findings: report.findings.length,
    summary: actions.summary,
  };
}

function summarizeDigest(report: HiveHealthReport): string {
  const total = report.findings.length;
  if (total === 0) {
    return [
      "Hive health digest: no supervisor findings.",
      `${report.metrics.activeGoals} active goal${report.metrics.activeGoals === 1 ? "" : "s"},`,
      `${report.metrics.openTasks} open task${report.metrics.openTasks === 1 ? "" : "s"},`,
      `${report.metrics.openDecisions} open decision${report.metrics.openDecisions === 1 ? "" : "s"}.`,
    ].join(" ");
  }

  const severityCounts = report.findings.reduce(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { critical: 0, warn: 0, info: 0 } as Record<"critical" | "warn" | "info", number>,
  );
  const kindCounts = new Map<string, number>();
  for (const finding of report.findings) {
    kindCounts.set(finding.kind, (kindCounts.get(finding.kind) ?? 0) + 1);
  }
  const kinds = Array.from(kindCounts.entries())
    .map(([kind, count]) => `${count} ${kind.replace(/_/g, " ")}`)
    .join(" · ");
  return [
    `Hive health digest: ${total} finding${total === 1 ? "" : "s"}.`,
    `${severityCounts.critical} critical, ${severityCounts.warn} warn, ${severityCounts.info} info.`,
    kinds,
  ].join(" ");
}

function countOutcomes(
  outcomes: AppliedOutcome[],
  status: AppliedOutcome["status"],
): number {
  return outcomes.filter((o) => o.status === status).length;
}

const HEARTBEAT_STDERR_PATTERNS = [
  /thread(?:\s+[\w.-]+)?\s+not found/i,
  /failed to record rollout items/i,
  /rollout-record/i,
  /rollout registration failed/i,
] as const;

const CODEX_SALVAGE_WARNING_PREFIX =
  "Codex rollout registration failed after agent output was captured";

const HEARTBEAT_STDERR_GATE_TITLE =
  "Investigate hive-supervisor heartbeat stderr gate";

interface EnforceHeartbeatProceduralGatesInput {
  hiveId: string;
  reportId: string;
  report: HiveHealthReport;
  actions: SupervisorActions;
}

async function enforceHeartbeatProceduralGates(
  sql: Sql,
  input: EnforceHeartbeatProceduralGatesInput,
): Promise<SupervisorActions> {
  const { hiveId, reportId, report, actions } = input;
  const stderrEvidence = findHeartbeatStderrEvidence(report);
  if (!stderrEvidence) return actions;

  const hasStderrDecision = actions.actions.some(
    (action) =>
      action.kind === "create_decision" &&
      matchesHeartbeatStderrPattern(
        [action.title, action.context, action.recommendation ?? ""].join("\n"),
      ),
  );
  if (hasStderrDecision) return actions;

  const decision = {
    kind: "create_decision" as const,
    tier: 2 as const,
    title: HEARTBEAT_STDERR_GATE_TITLE,
    context:
      "The heartbeat report contains session stderr or rollout-record evidence " +
      `that matches the mandatory stderr scan gate: ${stderrEvidence}`,
    recommendation:
      "Investigate the Codex adapter/session rollout-record path before treating this heartbeat as healthy or spawning implementation follow-ups.",
  };

  if (
    await wasSameHeartbeatStderrGateDecisionInPreviousReport(sql, {
      hiveId,
      reportId,
      decision,
    })
  ) {
    return {
      ...actions,
      summary:
        `${actions.summary} Mandatory stderr scan gate nooped because the immediately previous heartbeat created the identical decision.`,
      actions: [
        {
          kind: "noop",
          reasoning:
            "mandatory stderr scan gate skipped duplicate of the immediately previous heartbeat decision",
        },
        ...actions.actions.filter((action) => action.kind !== "spawn_followup"),
      ],
    };
  }

  return {
    ...actions,
    summary:
      `${actions.summary} Mandatory stderr scan gate inserted an EA-routed decision before follow-up work.`,
    actions: [
      decision,
      ...actions.actions.filter((action) => action.kind !== "spawn_followup"),
    ],
  };
}

function findHeartbeatStderrEvidence(report: HiveHealthReport): string | null {
  for (const text of collectHeartbeatStderrCandidateStrings(report)) {
    if (matchesHeartbeatStderrPattern(text)) {
      return text;
    }
  }
  return null;
}

function matchesHeartbeatStderrPattern(text: string): boolean {
  return HEARTBEAT_STDERR_PATTERNS.some((pattern) => pattern.test(text));
}

function collectHeartbeatStderrCandidateStrings(
  report: HiveHealthReport,
): string[] {
  return [
    report.hiveId,
    report.scannedAt,
    ...collectStrings(report.metrics),
    ...report.findings.flatMap(collectFindingStringsForStderrGate),
  ];
}

function collectFindingStringsForStderrGate(
  finding: HiveHealthReport["findings"][number],
): string[] {
  const detail = { ...finding.detail };
  const failureReason = detail.failureReason;

  if (
    finding.kind === "unsatisfied_completion" &&
    typeof failureReason === "string" &&
    isBenignCodexSalvageFailureReason(failureReason)
  ) {
    delete detail.failureReason;
  }

  return [
    finding.id,
    finding.kind,
    finding.severity,
    finding.summary,
    ...collectStrings(finding.ref),
    ...collectStrings(detail),
  ];
}

function isBenignCodexSalvageFailureReason(reason: string): boolean {
  const normalized = reason.trim();
  if (!normalized.startsWith(CODEX_SALVAGE_WARNING_PREFIX)) return false;

  // The salvage prefix itself matches the rollout-registration regex. Keep
  // the exemption narrow: if the field also carries separate harmful stderr
  // evidence, let the gate escalate it.
  return ![
    /thread(?:\s+[\w.-]+)?\s+not found/i,
    /failed to record rollout items/i,
    /rollout-record/i,
  ].some((pattern) => pattern.test(normalized));
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

async function wasSameHeartbeatStderrGateDecisionInPreviousReport(
  sql: Sql,
  input: {
    hiveId: string;
    reportId: string;
    decision: Extract<SupervisorActions["actions"][number], { kind: "create_decision" }>;
  },
): Promise<boolean> {
  const [row] = await sql<{ actions: SupervisorActions | null }[]>`
    SELECT actions
    FROM supervisor_reports
    WHERE hive_id = ${input.hiveId}
      AND id <> ${input.reportId}
      AND actions IS NOT NULL
    ORDER BY ran_at DESC
    LIMIT 1
  `;

  const previousActions = row?.actions?.actions;
  if (!Array.isArray(previousActions)) return false;

  const expectedFingerprint = decisionFingerprint(input.decision);
  return previousActions.some(
    (action) =>
      action.kind === "create_decision" &&
      isHeartbeatStderrGateDecision(action) &&
      decisionFingerprint(action) === expectedFingerprint,
  );
}

function isHeartbeatStderrGateDecision(
  action: SupervisorActions["actions"][number],
): action is Extract<SupervisorActions["actions"][number], { kind: "create_decision" }> {
  return (
    action.kind === "create_decision" &&
    action.tier === 2 &&
    action.title === HEARTBEAT_STDERR_GATE_TITLE
  );
}

function decisionFingerprint(
  action: Extract<SupervisorActions["actions"][number], { kind: "create_decision" }>,
): string {
  return JSON.stringify({
    kind: action.kind,
    tier: action.tier,
    title: action.title,
    context: action.context,
    recommendation: action.recommendation ?? null,
    options: action.options ?? null,
  });
}

/**
 * Finalizes a deferred heartbeat report after the hive-supervisor agent
 * task completes. The production heartbeat path returns output="" from
 * `defaultInvokeAgent` so the schedule timer doesn't block on an agent
 * turn; this helper is the dispatcher-side writeback that closes the loop.
 *
 * Mirrors the runSupervisor parse → apply → persist / escalate branches
 * but sources the output from the completed task instead of an in-band
 * agent callback. Lookup is by `agent_task_id`, which runSupervisor's
 * default agent populates on the row at heartbeat time.
 *
 * **Idempotency guard:** if `actions` is already non-null on the row, the
 * helper returns `already_finalized` without re-running the applier.
 * Prevents a dispatcher restart mid-completion from double-writing
 * decisions, spawn_followup tasks, or hive_memory entries.
 */
export async function finalizeDeferredSupervisorReport(
  sql: Sql,
  input: FinalizeDeferredReportInput,
): Promise<FinalizeDeferredReportResult> {
  const { taskId, hiveId, agentOutput } = input;

  const [row] = await sql<{ id: string; actions: unknown; report: unknown }[]>`
    SELECT id, actions, report
    FROM supervisor_reports
    WHERE agent_task_id = ${taskId}
    ORDER BY ran_at DESC
    LIMIT 1
  `;

  if (!row) {
    return { status: "no_report_row" };
  }

  const reportId = row.id;
  await syncDeferredAgentTelemetry(sql, reportId, taskId);

  if (row.actions !== null) {
    return { status: "already_finalized", reportId };
  }

  if (!agentOutput || agentOutput.trim() === "") {
    return { status: "empty_output", reportId };
  }

  const parsed = parseSupervisorActions(agentOutput);
  if (!parsed.ok) {
    await escalateMalformedSupervisorOutput(sql, {
      hiveId,
      reportId,
      reason: parsed.error,
      rawOutput: agentOutput,
    });
    return { status: "malformed", reportId, reason: parsed.error };
  }

  const gatedActions = await enforceHeartbeatProceduralGates(sql, {
    hiveId,
    reportId,
    report: row.report as HiveHealthReport,
    actions: parsed.value,
  });
  const outcomes = await applySupervisorActions(sql, hiveId, gatedActions, {
    report: row.report as HiveHealthReport,
  });
  await persistActions(sql, reportId, gatedActions, outcomes);

  return {
    status: "applied",
    reportId,
    actionsApplied: countOutcomes(outcomes, "applied"),
    actionsSkipped: countOutcomes(outcomes, "skipped"),
    actionsErrored: countOutcomes(outcomes, "error"),
  };
}

async function persistAgentMetadata(
  sql: Sql,
  reportId: string,
  agentResult: InvokeSupervisorAgentResult,
): Promise<void> {
  const hasUsageMetadata = [
    agentResult.totalContextTokens,
    agentResult.freshInputTokens,
    agentResult.cachedInputTokens,
    agentResult.tokensInput,
    agentResult.tokensOutput,
    agentResult.estimatedBillableCostCents,
    agentResult.costCents,
  ].some((value) => value !== null && value !== undefined);

  if (!hasUsageMetadata) {
    await sql`
      UPDATE supervisor_reports
      SET agent_task_id = ${agentResult.taskId ?? null}
      WHERE id = ${reportId}
    `;
    return;
  }

  const usage = normalizeBillableUsage({
    totalInputTokens: agentResult.totalContextTokens ?? agentResult.tokensInput,
    freshInputTokens: agentResult.freshInputTokens,
    cachedInputTokens: agentResult.cachedInputTokens,
    cachedInputTokensKnown: agentResult.cachedInputTokensKnown,
    tokensOutput: agentResult.tokensOutput,
    estimatedBillableCostCents: agentResult.estimatedBillableCostCents,
    legacyCostCents: agentResult.costCents,
  });

  await sql`
    UPDATE supervisor_reports
    SET agent_task_id = ${agentResult.taskId ?? null},
        fresh_input_tokens = ${usage.freshInputTokens},
        cached_input_tokens = ${usage.cachedInputTokens},
        cached_input_tokens_known = ${usage.cachedInputTokensKnown},
        tokens_output = ${usage.tokensOutput},
        total_context_tokens = ${usage.totalContextTokens},
        estimated_billable_cost_cents = ${usage.estimatedBillableCostCents},
        tokens_input = ${usage.legacy.tokensInput},
        cost_cents = ${usage.legacy.costCents}
    WHERE id = ${reportId}
  `;
}

async function syncDeferredAgentTelemetry(
  sql: Sql,
  reportId: string,
  taskId: string,
): Promise<void> {
  await sql`
    UPDATE supervisor_reports
    SET fresh_input_tokens = COALESCE(tasks.fresh_input_tokens, supervisor_reports.fresh_input_tokens),
        cached_input_tokens = COALESCE(tasks.cached_input_tokens, supervisor_reports.cached_input_tokens),
        cached_input_tokens_known = COALESCE(tasks.cached_input_tokens_known, supervisor_reports.cached_input_tokens_known),
        total_context_tokens = COALESCE(tasks.total_context_tokens, supervisor_reports.total_context_tokens),
        estimated_billable_cost_cents = COALESCE(tasks.estimated_billable_cost_cents, supervisor_reports.estimated_billable_cost_cents),
        tokens_input = COALESCE(tasks.tokens_input, supervisor_reports.tokens_input),
        tokens_output = COALESCE(tasks.tokens_output, supervisor_reports.tokens_output),
        cost_cents = COALESCE(tasks.cost_cents, supervisor_reports.cost_cents)
    FROM tasks
    WHERE supervisor_reports.id = ${reportId}
      AND tasks.id = ${taskId}
  `;
}

async function persistActions(
  sql: Sql,
  reportId: string,
  actions: SupervisorActions,
  outcomes: AppliedOutcome[],
): Promise<void> {
  await sql`
    UPDATE supervisor_reports
    SET actions = ${sql.json(toJsonValue(actions))},
        action_outcomes = ${sql.json(toJsonValue(outcomes))}
    WHERE id = ${reportId}
  `;
}

/**
 * Production default: spawn a hive-supervisor task with the report in its
 * brief and return an empty output. The schedule timer must not block for
 * the duration of an agent turn; the dispatcher's hive-supervisor task-
 * completion hook (wired separately) picks up the output and invokes the
 * parse/apply flow by calling back into runSupervisor's primitives.
 *
 * Returning output="" intentionally leaves actions/action_outcomes NULL
 * on the supervisor_reports row — they stay NULL until the agent task
 * completes and the hook writes them.
 */
function defaultInvokeAgent(sql: Sql): InvokeSupervisorAgent {
  return async ({ hiveId, reportId, report }) => {
    const brief = buildSupervisorBrief(report, reportId);
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (
        ${hiveId},
        'hive-supervisor',
        'dispatcher',
        ${`Hive supervisor heartbeat — ${report.findings.length} finding(s)`},
        ${brief}
      )
      RETURNING id
    `;
    return { output: "", taskId: task.id };
  };
}

/**
 * Builds the Markdown brief fed to the supervisor agent. Includes the
 * report id (for the agent's own audit reference), structural metrics,
 * and every finding with severity + id (the agent addresses findings by
 * id in SupervisorActions.findings_addressed).
 */
export function buildSupervisorBrief(
  report: HiveHealthReport,
  reportId: string,
): string {
  const findingLines = report.findings.length
    ? report.findings.map(
        (f) => {
          const diagnosticSuffix = f.kind === "recurring_failure" && f.detail.codexEmptyOutput
            ? `; codexEmptyOutput=true rolloutSignaturePresent=${Boolean(f.detail.rolloutSignaturePresent)} modelProviderMismatchDetected=${Boolean(f.detail.modelProviderMismatchDetected)} diagnosticEffectiveAdapters=${Array.isArray(f.detail.diagnosticEffectiveAdapters) ? f.detail.diagnosticEffectiveAdapters.join(",") : ""} diagnosticAdapterOverrides=${Array.isArray(f.detail.diagnosticAdapterOverrides) ? f.detail.diagnosticAdapterOverrides.join(",") : ""} diagnosticModels=${Array.isArray(f.detail.diagnosticModels) ? f.detail.diagnosticModels.join(",") : ""} diagnosticTaskIds=${Array.isArray(f.detail.diagnosticTaskIds) ? f.detail.diagnosticTaskIds.join(",") : ""}`
            : "";
          return `- [${f.severity}] ${f.kind} (${f.id}): ${f.summary}${diagnosticSuffix}`;
        },
      )
    : ["- (no findings)"];
  return [
    "## Hive Health Report",
    "",
    `Report ID: ${reportId}`,
    `Hive ID: ${report.hiveId}`,
    `Scanned at: ${report.scannedAt}`,
    "",
    "### Metrics",
    `- Open tasks: ${report.metrics.openTasks}`,
    `- Active goals: ${report.metrics.activeGoals}`,
    `- Open decisions: ${report.metrics.openDecisions}`,
    `- Tasks completed (24h): ${report.metrics.tasksCompleted24h}`,
    `- Tasks failed (24h): ${report.metrics.tasksFailed24h}`,
    "",
    ...formatOperatingContext(report),
    `### Findings (${report.findings.length})`,
    ...findingLines,
    "",
    "End your reply with a fenced ```json block containing a valid",
    "SupervisorActions object. Use findings_addressed to reference finding",
    "ids. Lightest-touch action wins; when in doubt, emit",
    "create_decision (tier 2) and let the EA triage.",
    "When create_decision presents genuine named runtime/auth/product/process",
    "alternatives, include options[] with stable key, label, consequence or",
    "description, and response/canonicalResponse. Keep simple approve/reject",
    "decisions as title/context/recommendation without options.",
    "For auth/runtime/third-party/connector/product-fork route choices, first",
    "mentally enumerate: (a) add a new credential/key/account/subscription,",
    "(b) reuse an existing credential, connector, infrastructure path, or",
    "subscription the hive already has (credentials table, env, Codex auth,",
    "Claude Code auth, known paid subscriptions), (c) switch to a different",
    "already-installed connector/path, and (d) defer. Include every technically",
    "feasible option. Hiding the reuse-existing path while listing a new key is",
    "a known anti-pattern.",
  ].join("\n");
}

function formatOperatingContext(report: HiveHealthReport): string[] {
  const context = report.operatingContext;
  if (!context) return [];

  const readiness = context.resumeReadiness;
  const blockers = readiness.blockers.map((blocker) => blocker.code);
  const lines = [
    "### Operating Context",
    `- Creation paused: ${context.creationPause.paused ? "yes" : "no"}`,
    `- Operating state: ${context.creationPause.operatingState}`,
    `- Pause reason: ${context.creationPause.reason ?? "none"}`,
    `- Paused schedules snapshot: ${context.creationPause.pausedScheduleIds.length}`,
    `- Resume readiness: ${readiness.status}`,
    `- Runnable tasks: ${readiness.counts.runnableTasks}`,
    `- Enabled schedules: ${readiness.counts.enabledSchedules}`,
    `- Pending owner decisions: ${readiness.counts.pendingDecisions}`,
    `- Unresolvable tasks: ${readiness.counts.unresolvableTasks}`,
    `- Model routes: ${readiness.models.ready} ready / ${readiness.models.enabled} enabled; blocked ${readiness.models.blocked}`,
    `- Persistent-session routes: ${readiness.sessions.persistentRoutes}; fallback routes: ${readiness.sessions.fallbackRoutes}`,
    `- Targets: ${context.targets.open} open; ${context.targets.overdueOpen} overdue; ${context.targets.dueSoonOpen} due soon`,
    `- Blockers: ${blockers.length ? blockers.join(", ") : "none"}`,
    "",
  ];

  if (context.targets.openTargets.length > 0) {
    lines.push(
      "#### Open Targets",
      ...context.targets.openTargets.slice(0, 5).map((target) => {
        const value = target.targetValue ? ` target=${target.targetValue}` : "";
        const deadline = target.deadline ? ` deadline=${target.deadline}` : "";
        return `- ${target.title}${value}${deadline}`;
      }),
      "",
    );
  }

  if (readiness.models.blockedRoutes.length > 0) {
    lines.push(
      "#### Blocked Model Routes",
      ...readiness.models.blockedRoutes.slice(0, 10).map(
        (route) =>
          `- ${route.adapterType}/${route.modelId}: ${route.reason}${route.failureReason ? ` (${route.failureReason})` : ""}`,
      ),
      "",
    );
  }

  return lines;
}
