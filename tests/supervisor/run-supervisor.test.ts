import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { buildSupervisorBrief, runSupervisor, runSupervisorDigest } from "@/supervisor";
import type { InvokeSupervisorAgent, SupervisorActions } from "@/supervisor";

/**
 * Integration tests for the heartbeat entry flow.
 *
 * Three scenarios, all against the real test DB (no mocks for the scan
 * engine or applier — only the supervisor agent itself is injected):
 *
 *   1. No findings → LLM is skipped, zero supervisor_reports rows written.
 *   2. Findings present + mock agent returns valid JSON → row persisted
 *      with actions + outcomes, follow-up task created per spawn_followup.
 *   3. Findings present + malformed agent output → ea_review decision
 *      created, action_outcomes records the parse failure.
 *
 * The scan-fixture helper seeds an aging_decision finding because that
 * detector is the simplest to trigger deterministically: a single
 * non-urgent decisions row older than 24h with no recent messages.
 */

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const PARENT_TASK_ID = "22222222-2222-2222-2222-222222222222";

async function seedRoleTemplates() {
  const slugs: Array<[string, string, string]> = [
    ["design-agent", "Design Agent", "executor"],
    ["dev-agent", "Dev Agent", "executor"],
    ["hive-supervisor", "Hive Supervisor", "system"],
  ];
  for (const [slug, name, type] of slugs) {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES (${slug}, ${name}, ${type}, 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
  }
}

async function seedHive(): Promise<void> {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'run-sup-test', 'Run Supervisor Test', 'digital')
  `;
}

/** Inserts a finding-triggering aging_decision. Returns the decision id. */
async function seedAgingDecision(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO decisions (hive_id, title, context, priority, status, created_at)
    VALUES (
      ${HIVE_ID},
      'aging decision fixture',
      'context',
      'normal',
      'pending',
      NOW() - interval '48 hours'
    )
    RETURNING id
  `;
  return row.id;
}

async function seedThreadNotFoundRecurringFailure(): Promise<void> {
  const failureReason =
    "codex_core::session: failed to record rollout items: thread 019dd0b1 not found";
  for (let i = 1; i <= 3; i += 1) {
    await sql`
      INSERT INTO tasks (
        id, hive_id, assigned_to, created_by, status, title, brief,
        failure_reason, created_at, updated_at
      )
      VALUES (
        ${`22222222-2222-2222-2222-22222222222${i}`},
        ${HIVE_ID},
        'dev-agent',
        'dispatcher',
        'failed',
        ${`thread-not-found failed task ${i}`},
        'Synthetic heartbeat stderr fixture.',
        ${failureReason},
        NOW() - interval '10 minutes',
        NOW() - interval '9 minutes'
      )
    `;
  }
}

async function seedCompletedTaskWithFailureReason(input: {
  id: string;
  failureReason: string;
}): Promise<void> {
  await sql`
    INSERT INTO tasks (
      id, hive_id, assigned_to, created_by, status, title, brief,
      result_summary, failure_reason, completed_at, created_at, updated_at
    )
    VALUES (
      ${input.id},
      ${HIVE_ID},
      'dev-agent',
      'dispatcher',
      'completed',
      'completed task with adapter metadata',
      'Synthetic unsatisfied-completion fixture.',
      'Agent output was captured and persisted.',
      ${input.failureReason},
      NOW() - interval '5 minutes',
      NOW() - interval '10 minutes',
      NOW() - interval '5 minutes'
    )
  `;
}

async function seedDormantGoal(goalId: string): Promise<void> {
  await sql`
    INSERT INTO goals (id, hive_id, title, status, created_at, updated_at, last_woken_sprint)
    VALUES (
      ${goalId},
      ${HIVE_ID},
      'Dormant goal fixture',
      'active',
      NOW() - interval '72 hours',
      NOW() - interval '72 hours',
      5
    )
  `;
}

async function seedInitiativeSuppression(input: {
  runId: string;
  goalId: string;
  suppressionReason: string;
}): Promise<void> {
  await sql`
    INSERT INTO initiative_runs (
      id, hive_id, trigger_type, trigger_ref, status, started_at, completed_at,
      evaluated_candidates, created_count, created_goals, created_tasks,
      created_decisions, suppressed_count, noop_count, suppression_reasons,
      guardrail_config, run_failures, failure_reason
    )
    VALUES (
      ${input.runId},
      ${HIVE_ID},
      'schedule',
      'fixture-schedule',
      'completed',
      NOW() - interval '10 minutes',
      NOW() - interval '9 minutes',
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      ${sql.json({ [input.suppressionReason]: 1 })},
      ${sql.json({ source: "test" })},
      0,
      NULL
    )
  `;

  await sql`
    INSERT INTO initiative_run_decisions (
      run_id, hive_id, trigger_type, candidate_key, candidate_ref,
      action_taken, rationale, suppression_reason, dedupe_key,
      cooldown_hours, per_run_cap, per_day_cap, evidence
    )
    VALUES (
      ${input.runId},
      ${HIVE_ID},
      'schedule',
      ${`dormant-goal-next-task:${input.goalId}`},
      ${input.goalId},
      'suppress',
      'Fixture suppression decision.',
      ${input.suppressionReason},
      ${`dormant-goal-next-task:${input.goalId}`},
      24,
      1,
      5,
      ${sql.json({
        suppression: {
          reason: input.suppressionReason,
        },
      })}
    )
  `;
}

/**
 * Mock InvokeSupervisorAgent that returns the given SupervisorActions
 * wrapped in a fenced ```json block so parseSupervisorActions accepts it.
 */
function mockAgentReturning(actions: SupervisorActions): InvokeSupervisorAgent {
  return async () => ({
    output: [
      "Here's my analysis.",
      "",
      "```json",
      JSON.stringify(actions, null, 2),
      "```",
    ].join("\n"),
    taskId: null,
    tokensInput: 120,
    tokensOutput: 80,
    costCents: 3,
  });
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedRoleTemplates();
  await seedHive();
});

describe.sequential("runSupervisor suites", () => {
describe.sequential("runSupervisorDigest — on-demand read-only report", () => {
  it("persists a scan-only report without invoking an agent or creating work", async () => {
    await seedAgingDecision();

    const result = await runSupervisorDigest(sql, HIVE_ID);

    expect(result.skipped).toBe(false);
    expect(result.reportId).not.toBeNull();
    expect(result.findings).toBeGreaterThanOrEqual(1);
    expect(result.summary).toContain("Hive health digest");

    const [report] = await sql<{
      report: { fingerprint?: string; findings: Array<{ kind: string }> };
      actions: { summary: string; actions: unknown[] };
      action_outcomes: unknown[];
      agent_task_id: string | null;
      tokens_input: number | null;
      tokens_output: number | null;
      cost_cents: number | null;
    }[]>`
      SELECT report, actions, action_outcomes, agent_task_id,
             tokens_input, tokens_output, cost_cents
      FROM supervisor_reports
      WHERE id = ${result.reportId}
    `;

    expect(report.report.findings.map((finding) => finding.kind)).toContain("aging_decision");
    expect(typeof report.report.fingerprint).toBe("string");
    expect(report.actions.summary).toBe(result.summary);
    expect(report.actions.actions).toEqual([]);
    expect(report.action_outcomes).toEqual([]);
    expect(report.agent_task_id).toBeNull();
    expect(report.tokens_input).toBeNull();
    expect(report.tokens_output).toBeNull();
    expect(report.cost_cents).toBe(0);

    const createdWork = await sql`
      SELECT id FROM tasks WHERE hive_id = ${HIVE_ID} AND created_by = 'hive-supervisor'
    `;
    expect(createdWork).toHaveLength(0);
  });
});

describe.sequential("runSupervisor — no-findings short-circuit", () => {
  it("skips LLM invocation and writes no supervisor_reports row when the scan is clean", async () => {
    let invokeCalled = false;
    const mockAgent: InvokeSupervisorAgent = async () => {
      invokeCalled = true;
      return { output: "should not be called" };
    };

    const result = await runSupervisor(sql, HIVE_ID, { invokeAgent: mockAgent });

    expect(result.skipped).toBe(true);
    expect(result.reportId).toBeNull();
    expect(result.findings).toBe(0);
    expect(invokeCalled).toBe(false);

    const rows = await sql`SELECT * FROM supervisor_reports WHERE hive_id = ${HIVE_ID}`;
    expect(rows).toHaveLength(0);
  });

  it("skips agent invocation when the material report fingerprint is unchanged", async () => {
    await seedAgingDecision();
    const digest = await runSupervisorDigest(sql, HIVE_ID);

    const mockAgent: InvokeSupervisorAgent = async () => {
      throw new Error("agent should not be invoked for unchanged supervisor state");
    };
    const result = await runSupervisor(sql, HIVE_ID, { invokeAgent: mockAgent });

    expect(result).toMatchObject({
      skipped: true,
      reportId: null,
      findings: 1,
      actionsApplied: 0,
      actionsSkipped: 0,
      actionsErrored: 0,
    });
    const rows = await sql`
      SELECT id FROM supervisor_reports WHERE hive_id = ${HIVE_ID} ORDER BY ran_at
    `;
    expect(rows.map((row) => row.id)).toEqual([digest.reportId]);
  });
});

describe.sequential("runSupervisor — findings-present apply flow", () => {
  it("persists a supervisor_reports row, invokes the agent, parses and applies actions", async () => {
    await seedAgingDecision();

    // Also seed a parent task so spawn_followup has a valid originalTaskId.
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief)
      VALUES (
        ${PARENT_TASK_ID},
        ${HIVE_ID},
        'design-agent',
        'owner',
        'completed',
        'parent analysis task',
        'analysis brief'
      )
    `;

    const actions: SupervisorActions = {
      summary: "Escalate the aging decision + spawn an implementation follow-up.",
      findings_addressed: [],
      actions: [
        {
          kind: "noop",
          reasoning: "log-only for the second finding",
        },
        {
          kind: "spawn_followup",
          originalTaskId: PARENT_TASK_ID,
          assignedTo: "dev-agent",
          title: "Implement the honeycomb design recommendations",
          brief: "Use the design-agent's analysis as input.",
        },
      ],
    };

    const result = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(actions),
    });

    expect(result.skipped).toBe(false);
    expect(result.reportId).not.toBeNull();
    expect(result.findings).toBeGreaterThanOrEqual(1);
    expect(result.actionsApplied).toBe(2);
    expect(result.actionsErrored).toBe(0);
    expect(result.malformed).toBeUndefined();
    expect(result.deferred).toBeUndefined();

    const [row] = await sql<
      {
        report: unknown;
        actions: unknown;
        action_outcomes: unknown;
        tokens_input: number | null;
        tokens_output: number | null;
        cost_cents: number | null;
      }[]
    >`
      SELECT report, actions, action_outcomes, tokens_input, tokens_output, cost_cents
      FROM supervisor_reports
      WHERE hive_id = ${HIVE_ID}
    `;

    expect(row.report).toBeTruthy();
    expect(row.actions).toBeTruthy();
    expect(Array.isArray(row.action_outcomes)).toBe(true);
    expect((row.action_outcomes as Array<{ status: string }>).length).toBe(2);
    expect(row.tokens_input).toBe(120);
    expect(row.tokens_output).toBe(80);
    expect(row.cost_cents).toBe(3);

    // spawn_followup should have materialised a real follow-up task row.
    const [followup] = await sql<{ title: string; assigned_to: string; parent_task_id: string | null }[]>`
      SELECT title, assigned_to, parent_task_id FROM tasks
      WHERE created_by = 'hive-supervisor'
    `;
    expect(followup.title).toBe("Implement the honeycomb design recommendations");
    expect(followup.assigned_to).toBe("dev-agent");
    expect(followup.parent_task_id).toBe(PARENT_TASK_ID);
  });

  it("turns thread-not-found heartbeat stderr into create_decision instead of silent follow-up spawning", async () => {
    await seedThreadNotFoundRecurringFailure();

    const actions: SupervisorActions = {
      summary: "Incorrectly try to spawn a direct follow-up.",
      findings_addressed: [],
      actions: [
        {
          kind: "spawn_followup",
          originalTaskId: "22222222-2222-2222-2222-222222222221",
          assignedTo: "dev-agent",
          title: "Investigate repeated failed rollout records",
          brief: "Look into repeated thread-not-found failures.",
        },
      ],
    };

    const result = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(actions),
    });

    expect(result.skipped).toBe(false);
    expect(result.actionsApplied).toBe(1);
    expect(result.actionsSkipped).toBe(0);
    expect(result.actionsErrored).toBe(0);

    const [decision] = await sql<{ status: string; title: string; context: string }[]>`
      SELECT status, title, context
      FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_flagged'
    `;
    expect(decision.status).toBe("ea_review");
    expect(decision.title).toContain("heartbeat stderr gate");
    expect(decision.context).toContain("failed to record rollout items");
    expect(decision.context).toMatch(/thread .* not found/i);

    const [{ followups }] = await sql<{ followups: number }[]>`
      SELECT COUNT(*)::int AS followups
      FROM tasks
      WHERE hive_id = ${HIVE_ID} AND created_by = 'hive-supervisor'
    `;
    expect(followups).toBe(0);

    const [reportRow] = await sql<
      Array<{ actions: { actions: Array<{ kind: string; context?: string }> } }>
    >`
      SELECT actions
      FROM supervisor_reports
      WHERE id = ${result.reportId}
    `;
    expect(reportRow.actions.actions.map((action) => action.kind)).toEqual([
      "create_decision",
    ]);
    expect(reportRow.actions.actions[0].context).toContain(
      "mandatory stderr scan gate",
    );
  });

  it("does not create a stderr-gate decision for benign Codex salvage metadata on unsatisfied_completion failureReason", async () => {
    await seedCompletedTaskWithFailureReason({
      id: "22222222-2222-2222-2222-222222222230",
      failureReason:
        "Codex rollout registration failed after agent output was captured; salvaged output for idempotent dispatcher finalization.",
    });

    const result = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning({
        summary: "Treat benign Codex salvage metadata as already captured output.",
        findings_addressed: [
          "unsatisfied_completion:22222222-2222-2222-2222-222222222230",
        ],
        actions: [
          {
            kind: "noop",
            reasoning: "benign Codex salvage metadata",
          },
        ],
      }),
    });

    expect(result.skipped).toBe(false);
    expect(result.findings).toBe(1);
    expect(result.actionsApplied).toBe(1);
    expect(result.actionsErrored).toBe(0);

    const [{ decisions }] = await sql<{ decisions: number }[]>`
      SELECT COUNT(*)::int AS decisions
      FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_flagged'
    `;
    expect(decisions).toBe(0);

    const [reportRow] = await sql<
      Array<{ actions: { actions: Array<{ kind: string; reasoning?: string }> } }>
    >`
      SELECT actions
      FROM supervisor_reports
      WHERE id = ${result.reportId}
    `;
    expect(reportRow.actions.actions).toEqual([
      {
        kind: "noop",
        reasoning: "benign Codex salvage metadata",
      },
    ]);
  });

  it("includes codex empty-output flags in heartbeat report context without triggering the benign salvage exemption", () => {
    const brief = buildSupervisorBrief({
      hiveId: HIVE_ID,
      scannedAt: "2026-05-01T00:00:00.000Z",
      metrics: {
        openTasks: 0,
        activeGoals: 0,
        openDecisions: 0,
        tasksCompleted24h: 0,
        tasksFailed24h: 3,
      },
      findings: [
        {
          id: "recurring_failure:dev-agent:abc123",
          kind: "recurring_failure",
          severity: "critical",
          ref: { role: "dev-agent" },
          summary: "Recurring failure on dev-agent (3 in 24h): Codex exited code <n>",
          detail: {
            codexEmptyOutput: true,
            rolloutSignaturePresent: true,
            modelProviderMismatchDetected: true,
            diagnosticEffectiveAdapters: ["codex"],
            diagnosticAdapterOverrides: ["codex"],
            diagnosticModels: ["anthropic/claude-opus-4-7"],
            diagnosticTaskIds: [
              "22222222-2222-2222-2222-222222222221",
              "22222222-2222-2222-2222-222222222222",
            ],
          },
        },
      ],
    }, "report-1");

    expect(brief).toContain("codexEmptyOutput=true");
    expect(brief).toContain("rolloutSignaturePresent=true");
    expect(brief).toContain("modelProviderMismatchDetected=true");
    expect(brief).toContain("diagnosticEffectiveAdapters=codex");
    expect(brief).toContain("diagnosticAdapterOverrides=codex");
    expect(brief).toContain("diagnosticModels=anthropic/claude-opus-4-7");
    expect(brief).toContain("diagnosticTaskIds=22222222-2222-2222-2222-222222222221,22222222-2222-2222-2222-222222222222");
  });

  it("includes operating context in the supervisor brief when the scan provides it", () => {
    const brief = buildSupervisorBrief({
      hiveId: HIVE_ID,
      scannedAt: "2026-05-01T00:00:00.000Z",
      metrics: {
        openTasks: 0,
        activeGoals: 1,
        openDecisions: 0,
        tasksCompleted24h: 0,
        tasksFailed24h: 0,
      },
      operatingContext: {
        creationPause: {
          paused: true,
          reason: "manual recovery",
          pausedBy: "owner",
          updatedAt: "2026-05-01T00:00:00.000Z",
          operatingState: "paused",
          pausedScheduleIds: ["33333333-3333-4333-8333-333333333333"],
        },
        resumeReadiness: {
          status: "blocked",
          canResumeSafely: false,
          counts: {
            enabledSchedules: 0,
            runnableTasks: 0,
            pendingDecisions: 0,
            unresolvableTasks: 8,
          },
          models: {
            enabled: 2,
            ready: 1,
            blocked: 1,
            stale: 0,
            unavailable: 1,
            onDemand: 0,
            blockedRoutes: [
              {
                provider: "example-provider",
                adapterType: "example-adapter",
                modelId: "example-model",
                canRun: false,
                category: "unavailable",
                reason: "health_probe_missing",
              },
            ],
          },
          sessions: {
            persistentRoutes: 1,
            fallbackRoutes: 1,
            routes: [],
          },
          blockers: [
            {
              code: "model_health_blocked",
              label: "Models need fresh health evidence",
              count: 1,
              detail: "Every enabled model needs a fresh healthy probe before the dispatcher can spawn it.",
            },
          ],
          checkedAt: "2026-05-01T00:00:00.000Z",
        },
        targets: {
          open: 2,
          achieved: 1,
          abandoned: 0,
          overdueOpen: 1,
          dueSoonOpen: 1,
          openTargets: [
            {
              id: "44444444-4444-4444-8444-444444444441",
              title: "Reduce failed work",
              targetValue: "0 failed tasks",
              deadline: "2026-05-01",
              sortOrder: 0,
            },
          ],
        },
      },
      findings: [],
    }, "report-1");

    expect(brief).toContain("### Operating Context");
    expect(brief).toContain("- Creation paused: yes");
    expect(brief).toContain("- Resume readiness: blocked");
    expect(brief).toContain("- Model routes: 1 ready / 2 enabled; blocked 1");
    expect(brief).toContain("- Targets: 2 open; 1 overdue; 1 due soon");
    expect(brief).toContain("Reduce failed work");
    expect(brief).toContain("- Blockers: model_health_blocked");
  });

  it("noops the stderr gate when the immediately previous heartbeat created the identical decision", async () => {
    await seedThreadNotFoundRecurringFailure();

    const actions: SupervisorActions = {
      summary: "Incorrectly try to spawn a direct follow-up.",
      findings_addressed: [],
      actions: [
        {
          kind: "spawn_followup",
          originalTaskId: "22222222-2222-2222-2222-222222222221",
          assignedTo: "dev-agent",
          title: "Investigate repeated failed rollout records",
          brief: "Look into repeated thread-not-found failures.",
        },
      ],
    };

    const first = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(actions),
    });
    expect(first.actionsApplied).toBe(1);

    const second = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(actions),
    });
    expect(second.actionsApplied).toBe(1);
    expect(second.actionsErrored).toBe(0);

    const [{ decisions }] = await sql<{ decisions: number }[]>`
      SELECT COUNT(*)::int AS decisions
      FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_flagged'
    `;
    expect(decisions).toBe(1);

    const [secondReport] = await sql<
      Array<{ actions: { actions: Array<{ kind: string; reasoning?: string }> } }>
    >`
      SELECT actions
      FROM supervisor_reports
      WHERE id = ${second.reportId}
    `;
    expect(secondReport.actions.actions).toEqual([
      {
        kind: "noop",
        reasoning:
          "mandatory stderr scan gate skipped duplicate of the immediately previous heartbeat decision",
      },
    ]);
  });

  it("skips wake_goal when the scanned dormant goal carries same-run per_run_cap suppression evidence", async () => {
    const goalId = "33333333-3333-3333-3333-333333333333";
    const runId = "44444444-4444-4444-4444-444444444444";
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await seedDormantGoal(goalId);
    await seedInitiativeSuppression({
      runId,
      goalId,
      suppressionReason: "per_run_cap",
    });

    const actions: SupervisorActions = {
      summary: "Attempt to wake the dormant goal.",
      findings_addressed: [],
      actions: [
        {
          kind: "wake_goal",
          goalId,
          reasoning: "No activity in 72h",
        },
      ],
    };

    try {
      const result = await runSupervisor(sql, HIVE_ID, {
        invokeAgent: mockAgentReturning(actions),
      });

      expect(result.skipped).toBe(false);
      expect(result.actionsApplied).toBe(0);
      expect(result.actionsSkipped).toBe(1);
      expect(infoSpy).toHaveBeenCalledWith(
        "[supervisor] wake_goal skipped by same-run suppression",
        {
          goalId,
          runId,
          suppressionReason: "per_run_cap",
        },
      );

      const [goal] = await sql<{ last_woken_sprint: number | null }[]>`
        SELECT last_woken_sprint FROM goals WHERE id = ${goalId}
      `;
      expect(goal.last_woken_sprint).toBe(5);

      const [reportRow] = await sql<
        { action_outcomes: Array<{ status: string; detail: string }>; report: { findings: Array<{ detail: { initiative?: { latestSuppression?: { runId?: string; suppressionReason?: string } | null } | null } }> } }[]
      >`
        SELECT action_outcomes, report
        FROM supervisor_reports
        WHERE id = ${result.reportId}
      `;
      expect(reportRow.action_outcomes[0]).toMatchObject({
        status: "skipped",
      });
      expect(reportRow.action_outcomes[0].detail).toContain(runId);
      expect(reportRow.report.findings[0]?.detail.initiative?.latestSuppression).toMatchObject({
        runId,
        suppressionReason: "per_run_cap",
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("routes malformed agent output through the malformed-escalation path", async () => {
    await seedAgingDecision();

    const malformedAgent: InvokeSupervisorAgent = async () => ({
      output: "The JSON block is missing entirely.",
      taskId: null,
    });

    const result = await runSupervisor(sql, HIVE_ID, { invokeAgent: malformedAgent });

    expect(result.skipped).toBe(false);
    expect(result.malformed).toBe(true);
    expect(result.actionsApplied).toBe(0);

    // Audit row is present with an error outcome.
    const [row] = await sql<
      { actions: unknown; action_outcomes: Array<{ status: string; detail: string }> }[]
    >`
      SELECT actions, action_outcomes
      FROM supervisor_reports
      WHERE hive_id = ${HIVE_ID}
    `;
    expect(row.actions).toBeNull();
    expect(row.action_outcomes[0].status).toBe("error");
    expect(row.action_outcomes[0].detail).toMatch(/malformed/i);

    // Governance-critical: malformed output must create an ea_review
    // decision (never pending — owner is a USER, the EA buffer handles
    // parse-error recovery first).
    const [decision] = await sql<{ status: string; kind: string }[]>`
      SELECT status, kind FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_malformed'
    `;
    expect(decision.status).toBe("ea_review");
  });

  it("leaves actions/outcomes NULL when the default agent invocation returns empty output (deferred apply)", async () => {
    await seedAgingDecision();

    // Don't pass an invokeAgent — exercise the production default.
    const result = await runSupervisor(sql, HIVE_ID);

    expect(result.skipped).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.actionsApplied).toBe(0);

    const [row] = await sql<
      { actions: unknown; action_outcomes: unknown; agent_task_id: string | null }[]
    >`
      SELECT actions, action_outcomes, agent_task_id
      FROM supervisor_reports
      WHERE hive_id = ${HIVE_ID}
    `;
    expect(row.actions).toBeNull();
    expect(row.action_outcomes).toBeNull();
    expect(row.agent_task_id).not.toBeNull();

    // The default invocation must enqueue a hive-supervisor task.
    const [task] = await sql<{ id: string; assigned_to: string; created_by: string }[]>`
      SELECT id, assigned_to, created_by FROM tasks
      WHERE assigned_to = 'hive-supervisor'
    `;
    expect(task.id).toBe(row.agent_task_id);
    expect(task.created_by).toBe("dispatcher");
  });
});

describe.sequential("runSupervisor — EA-first decision routing (governance end-to-end)", () => {
  it("tier 3 create_decision action persists as status='ea_review' through the full heartbeat flow", async () => {
    await seedAgingDecision();

    const actions: SupervisorActions = {
      summary: "Owner input needed — escalating as tier 3.",
      findings_addressed: [],
      actions: [
        {
          kind: "create_decision",
          tier: 3,
          title: "Recurring dev-agent timeouts require owner decision",
          context: "3 recurring failures in the last 24h with no recovery.",
          recommendation: "Pause the sprint and investigate adapter config.",
        },
      ],
    };

    const result = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(actions),
    });

    expect(result.skipped).toBe(false);
    expect(result.malformed).toBeUndefined();
    expect(result.actionsApplied).toBe(1);
    expect(result.actionsErrored).toBe(0);

    const rows = await sql<
      { status: string; priority: string; kind: string; title: string }[]
    >`
      SELECT status, priority, kind, title FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_flagged'
    `;
    expect(rows).toHaveLength(1);
    // Governance-critical assertion: tier 3 supervisor-created decisions
    // MUST land at ea_review, NEVER at pending. The EA is the owner-facing
    // buffer — a stray 'pending' here would page the owner directly.
    expect(rows[0].status).toBe("ea_review");
    expect(rows[0].status).not.toBe("pending");
    expect(rows[0].priority).toBe("urgent");
  });

  it("tier 2 create_decision action also persists as status='ea_review' end-to-end", async () => {
    await seedAgingDecision();

    const actions: SupervisorActions = {
      summary: "Flag for EA triage.",
      findings_addressed: [],
      actions: [
        {
          kind: "create_decision",
          tier: 2,
          title: "Aging decision needs EA attention",
          context: "Decision older than 24h with no messages.",
        },
      ],
    };

    const result = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(actions),
    });
    expect(result.actionsApplied).toBe(1);

    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_flagged'
    `;
    expect(row.status).toBe("ea_review");
    expect(row.status).not.toBe("pending");
  });

  it("NEVER inserts a decisions row with status='pending' through any supervisor runtime path", async () => {
    // Exercise the applied-action create_decision path (tiers 2 and 3) AND
    // the malformed-escalation path in the same test run, then count
    // pending inserts across all decisions rows the supervisor produced.
    // This is the end-to-end negative assertion: the plan explicitly
    // requires proving there is no direct pending insert on these
    // supervisor paths.
    await seedAgingDecision();

    const firstRun = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning({
        summary: "multi-tier decision escalation",
        findings_addressed: [],
        actions: [
          {
            kind: "create_decision",
            tier: 3,
            title: "tier 3 decision",
            context: "c",
          },
          {
            kind: "create_decision",
            tier: 2,
            title: "tier 2 decision",
            context: "c",
          },
        ],
      }),
    });
    expect(firstRun.actionsApplied).toBe(2);

    const secondRun = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: async () => ({
        output: "no fenced block here at all",
        taskId: null,
      }),
    });
    expect(secondRun.malformed).toBe(true);

    // Three supervisor-created decisions total (2 applied + 1 malformed
    // escalation) and EVERY SINGLE ONE must be ea_review.
    const [{ total }] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM decisions WHERE hive_id = ${HIVE_ID}
        AND kind IN ('supervisor_flagged', 'supervisor_malformed')
    `;
    expect(total).toBe(3);

    const [{ pending }] = await sql<{ pending: number }[]>`
      SELECT COUNT(*)::int AS pending FROM decisions
      WHERE hive_id = ${HIVE_ID}
        AND kind IN ('supervisor_flagged', 'supervisor_malformed')
        AND status = 'pending'
    `;
    expect(pending).toBe(0);

    const [{ eaReview }] = await sql<{ eaReview: number }[]>`
      SELECT COUNT(*)::int AS "eaReview" FROM decisions
      WHERE hive_id = ${HIVE_ID}
        AND kind IN ('supervisor_flagged', 'supervisor_malformed')
        AND status = 'ea_review'
    `;
    expect(eaReview).toBe(3);
  });
});

describe.sequential("runSupervisor — repeat-loop guardrail (end-to-end)", () => {
  it("two consecutive heartbeats with the same spawn_followup do NOT duplicate the follow-up task", async () => {
    // Repeat-loop regression: if the scan still flags the same stall on
    // the next heartbeat and the agent emits the same spawn_followup,
    // the applier's 24h dedupe window (keyed on assignedTo+title) must
    // keep the second run from creating a duplicate task. Without this,
    // the supervisor could silently amplify pending work every 15 minutes.
    await seedAgingDecision();
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief)
      VALUES (
        ${PARENT_TASK_ID},
        ${HIVE_ID},
        'design-agent',
        'owner',
        'completed',
        'parent analysis task',
        'analysis brief'
      )
    `;

    const sameActions: SupervisorActions = {
      summary: "Same spawn both heartbeats.",
      findings_addressed: [],
      actions: [
        {
          kind: "spawn_followup",
          originalTaskId: PARENT_TASK_ID,
          assignedTo: "dev-agent",
          title: "Implement the honeycomb design recommendations",
          brief: "Use the design-agent's analysis as input.",
        },
      ],
    };

    const first = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(sameActions),
    });
    expect(first.actionsApplied).toBe(1);

    const second = await runSupervisor(sql, HIVE_ID, {
      invokeAgent: mockAgentReturning(sameActions),
    });
    expect(second.actionsApplied).toBe(0);
    expect(second.actionsSkipped).toBe(1);

    // Only ONE follow-up task exists — the second heartbeat was deduped.
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM tasks
      WHERE hive_id = ${HIVE_ID} AND created_by = 'hive-supervisor'
    `;
    expect(count).toBe(1);
  });
});
});
