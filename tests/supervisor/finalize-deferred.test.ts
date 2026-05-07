import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  runSupervisor,
  finalizeDeferredSupervisorReport,
  type SupervisorActions,
} from "@/supervisor";

/**
 * Regression coverage for the deferred heartbeat finalization path.
 *
 * The production heartbeat uses `defaultInvokeAgent`, which enqueues a
 * hive-supervisor task and returns output="" so the schedule timer does
 * not block on an agent turn. The agent completes LATER via the normal
 * dispatcher task loop — its reply must be routed through parse → apply
 * → persist so the `supervisor_reports` row that was created up-front
 * actually gets its `actions` and `action_outcomes` columns filled in.
 *
 * The in-band `invokeAgent` tests in run-supervisor.test.ts cover the
 * synchronous apply path. This file covers the deferred/production path
 * that Sprint 3 canary evidence proved was silently dropping the agent's
 * output: the row stayed NULL forever because there was no task-completion
 * hook wired up.
 */

const HIVE_ID = "11111111-4444-4444-4444-111111111111";
const PARENT_TASK_ID = "22222222-4444-4444-4444-222222222222";

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
    VALUES (${HIVE_ID}, 'finalize-deferred-test', 'Finalize Deferred', 'digital')
  `;
}

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

function wrapAsFencedJson(actions: SupervisorActions): string {
  return [
    "Here's my structured response.",
    "",
    "```json",
    JSON.stringify(actions, null, 2),
    "```",
  ].join("\n");
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedRoleTemplates();
  await seedHive();
});

describe("finalizeDeferredSupervisorReport — deferred heartbeat writeback", () => {
  it("populates actions + action_outcomes on the supervisor_reports row linked to the completed agent task", async () => {
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

    // Simulate the production heartbeat: default invokeAgent enqueues a
    // hive-supervisor task + returns output="", leaving actions/outcomes NULL.
    const deferred = await runSupervisor(sql, HIVE_ID);
    expect(deferred.deferred).toBe(true);
    expect(deferred.reportId).not.toBeNull();

    const [rowBefore] = await sql<
      {
        actions: unknown;
        action_outcomes: unknown;
        agent_task_id: string | null;
      }[]
    >`
      SELECT actions, action_outcomes, agent_task_id
      FROM supervisor_reports
      WHERE id = ${deferred.reportId!}
    `;
    // Baseline: this is exactly the canary evidence we're fixing —
    // the row is created, the task is linked, but actions/outcomes are NULL.
    expect(rowBefore.actions).toBeNull();
    expect(rowBefore.action_outcomes).toBeNull();
    expect(rowBefore.agent_task_id).not.toBeNull();

    const agentOutput = wrapAsFencedJson({
      summary: "Escalate the aging decision and spawn an implementation follow-up.",
      findings_addressed: [],
      actions: [
        {
          kind: "spawn_followup",
          originalTaskId: PARENT_TASK_ID,
          assignedTo: "dev-agent",
          title: "Implement the aging-decision follow-up",
          brief: "Address the 48h aging decision.",
        },
        {
          kind: "log_insight",
          category: "operations",
          content: "Aging decisions older than 48h continue to appear in scans.",
        },
      ],
    });

    // This is the call the dispatcher will make when the hive-supervisor
    // task completes. It's the writeback hook that was missing.
    const finalized = await finalizeDeferredSupervisorReport(sql, {
      taskId: rowBefore.agent_task_id!,
      hiveId: HIVE_ID,
      agentOutput,
    });

    expect(finalized.status).toBe("applied");
    expect(finalized.reportId).toBe(deferred.reportId);
    expect(finalized.actionsApplied).toBe(2);
    expect(finalized.actionsErrored).toBe(0);

    const [rowAfter] = await sql<
      {
        actions: { actions: Array<{ kind: string }> } | null;
        action_outcomes: Array<{ status: string }> | null;
      }[]
    >`
      SELECT actions, action_outcomes
      FROM supervisor_reports
      WHERE id = ${deferred.reportId!}
    `;
    expect(rowAfter.actions).not.toBeNull();
    expect(rowAfter.actions!.actions).toHaveLength(2);
    expect(rowAfter.action_outcomes).not.toBeNull();
    expect(rowAfter.action_outcomes!).toHaveLength(2);
    expect(rowAfter.action_outcomes!.every((o) => o.status === "applied")).toBe(
      true,
    );

    // The spawn_followup materialized a real task row — proves the apply
    // branch ran, not just the persistence branch.
    const [followup] = await sql<
      { title: string; assigned_to: string; parent_task_id: string | null }[]
    >`
      SELECT title, assigned_to, parent_task_id
      FROM tasks
      WHERE hive_id = ${HIVE_ID} AND created_by = 'hive-supervisor'
    `;
    expect(followup.title).toBe("Implement the aging-decision follow-up");
    expect(followup.assigned_to).toBe("dev-agent");
    expect(followup.parent_task_id).toBe(PARENT_TASK_ID);
  });

  it("escalates via ea_review when deferred task completes with malformed output", async () => {
    await seedAgingDecision();

    const deferred = await runSupervisor(sql, HIVE_ID);
    expect(deferred.deferred).toBe(true);
    const [row] = await sql<{ agent_task_id: string | null }[]>`
      SELECT agent_task_id FROM supervisor_reports WHERE id = ${deferred.reportId!}
    `;

    const finalized = await finalizeDeferredSupervisorReport(sql, {
      taskId: row.agent_task_id!,
      hiveId: HIVE_ID,
      agentOutput: "No fenced JSON block here — supervisor went off-script.",
    });

    expect(finalized.status).toBe("malformed");
    expect(finalized.reportId).toBe(deferred.reportId);

    // Governance-critical: the malformed escalation MUST create an
    // ea_review decision, never pending. Deferred finalization must not
    // silently drop this contract just because it runs on a different
    // callsite than the in-band runSupervisor path.
    const [decision] = await sql<{ status: string; kind: string }[]>`
      SELECT status, kind FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_malformed'
    `;
    expect(decision.status).toBe("ea_review");
    expect(decision.status).not.toBe("pending");

    // The report row records the parse failure in action_outcomes.
    const [audit] = await sql<
      { actions: unknown; action_outcomes: Array<{ status: string; detail: string }> }[]
    >`
      SELECT actions, action_outcomes
      FROM supervisor_reports WHERE id = ${deferred.reportId!}
    `;
    expect(audit.actions).toBeNull();
    expect(audit.action_outcomes[0].status).toBe("error");
    expect(audit.action_outcomes[0].detail).toMatch(/malformed/i);
  });

  it("is idempotent — calling finalize twice does not duplicate create_decision rows", async () => {
    // The supervisor task-completion hook could fire twice if the
    // dispatcher restarts mid-completion. Finalization must be safe to
    // re-run: the second call should detect that actions is already
    // populated and skip, leaving the decisions row count unchanged.
    await seedAgingDecision();

    const deferred = await runSupervisor(sql, HIVE_ID);
    const [row] = await sql<{ agent_task_id: string | null }[]>`
      SELECT agent_task_id FROM supervisor_reports WHERE id = ${deferred.reportId!}
    `;
    const output = wrapAsFencedJson({
      summary: "Tier 3 escalation.",
      findings_addressed: [],
      actions: [
        {
          kind: "create_decision",
          tier: 3,
          title: "owner attention requested",
          context: "context",
        },
      ],
    });

    const first = await finalizeDeferredSupervisorReport(sql, {
      taskId: row.agent_task_id!,
      hiveId: HIVE_ID,
      agentOutput: output,
    });
    expect(first.status).toBe("applied");

    const second = await finalizeDeferredSupervisorReport(sql, {
      taskId: row.agent_task_id!,
      hiveId: HIVE_ID,
      agentOutput: output,
    });
    expect(second.status).toBe("already_finalized");

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_flagged'
    `;
    expect(count).toBe(1);
  });

  it("copies deferred hive-supervisor task token and cost telemetry onto the report", async () => {
    await seedAgingDecision();

    const deferred = await runSupervisor(sql, HIVE_ID);
    expect(deferred.deferred).toBe(true);

    const [row] = await sql<{ agent_task_id: string | null }[]>`
      SELECT agent_task_id FROM supervisor_reports WHERE id = ${deferred.reportId!}
    `;
    expect(row.agent_task_id).not.toBeNull();

    await sql`
      UPDATE tasks
      SET tokens_input = 1234,
          tokens_output = 567,
          cost_cents = 42,
          model_used = 'claude-telemetry-test'
      WHERE id = ${row.agent_task_id!}
    `;

    const finalized = await finalizeDeferredSupervisorReport(sql, {
      taskId: row.agent_task_id!,
      hiveId: HIVE_ID,
      agentOutput: wrapAsFencedJson({
        summary: "No action needed after review.",
        findings_addressed: [],
        actions: [{ kind: "noop", reasoning: "Telemetry test only." }],
      }),
    });
    expect(finalized.status).toBe("applied");

    const [report] = await sql<
      {
        tokens_input: number | null;
        tokens_output: number | null;
        cost_cents: number | null;
      }[]
    >`
      SELECT tokens_input, tokens_output, cost_cents
      FROM supervisor_reports
      WHERE id = ${deferred.reportId!}
    `;
    expect(report.tokens_input).toBe(1234);
    expect(report.tokens_output).toBe(567);
    expect(report.cost_cents).toBe(42);
  });

  it("returns no_report_row when the task has no linked supervisor_reports row", async () => {
    // A stray hive-supervisor task without a linked report (e.g., manual
    // INSERT for testing, or a future code path) must not crash the
    // dispatcher or leak rows into other hives. This is the safety net.
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief)
      VALUES (
        ${HIVE_ID}, 'hive-supervisor', 'dispatcher', 'completed',
        'orphan supervisor task', 'no report row linked'
      )
      RETURNING id
    `;

    const result = await finalizeDeferredSupervisorReport(sql, {
      taskId: task.id,
      hiveId: HIVE_ID,
      agentOutput: "anything — should not be parsed",
    });
    expect(result.status).toBe("no_report_row");
  });

  it("preserves EA-first decision routing through the deferred finalization path", async () => {
    // End-to-end governance assertion on the deferred path: a tier 3
    // create_decision action applied via finalization must land at
    // status='ea_review', never 'pending'. Mirrors the in-band assertion
    // in run-supervisor.test.ts so the deferred path cannot regress the
    // EA-first invariant.
    await seedAgingDecision();
    const deferred = await runSupervisor(sql, HIVE_ID);
    const [row] = await sql<{ agent_task_id: string | null }[]>`
      SELECT agent_task_id FROM supervisor_reports WHERE id = ${deferred.reportId!}
    `;

    await finalizeDeferredSupervisorReport(sql, {
      taskId: row.agent_task_id!,
      hiveId: HIVE_ID,
      agentOutput: wrapAsFencedJson({
        summary: "tier 3",
        findings_addressed: [],
        actions: [
          {
            kind: "create_decision",
            tier: 3,
            title: "tier 3 via deferred finalize",
            context: "context",
          },
        ],
      }),
    });

    const [decision] = await sql<{ status: string; priority: string }[]>`
      SELECT status, priority FROM decisions
      WHERE hive_id = ${HIVE_ID} AND kind = 'supervisor_flagged'
    `;
    expect(decision.status).toBe("ea_review");
    expect(decision.status).not.toBe("pending");
    expect(decision.priority).toBe("urgent");
  });
});
