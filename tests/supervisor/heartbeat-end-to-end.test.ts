import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";
import { runSupervisor } from "@/supervisor";
import type { InvokeSupervisorAgent, SupervisorActions } from "@/supervisor";
import { GET } from "@/app/api/supervisor-reports/route";

/**
 * End-to-end integration coverage that threads every implemented slice of
 * the supervisor heartbeat in a single scenario:
 *
 *   1. Schedule timer sees a `hive-supervisor-heartbeat` row come due and
 *      short-circuits to runSupervisor.
 *   2. A clean hive produces zero supervisor_reports rows and never
 *      invokes the LLM (default agent must not fire).
 *   3. A hive with findings runs the full parse → apply → persist chain
 *      when a mocked agent returns valid SupervisorActions; the row
 *      carries the report, actions, and per-action outcomes.
 *   4. /api/supervisor-reports returns the persisted row keyed by hiveId
 *      with the full camelCase shape the dashboard consumes, honouring
 *      the `limit` parameter.
 *
 * The existing per-file tests validate each slice in isolation; this file
 * is the "all four together" regression surface so a change to any one
 * slice can't silently drift the cross-layer contract.
 */

const CLEAN_HIVE = "aaaaaaaa-1111-1111-1111-111111111111";
const BUSY_HIVE = "bbbbbbbb-2222-2222-2222-222222222222";
const PARENT_TASK_ID = "cccccccc-3333-3333-3333-333333333333";

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

async function seedHive(id: string, slug: string): Promise<void> {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${id}, ${slug}, ${slug}, 'digital')
  `;
}

async function seedHeartbeatSchedule(hiveId: string): Promise<void> {
  await sql`
    INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
    VALUES (
      ${hiveId},
      '*/15 * * * *',
      ${sql.json({
        kind: "hive-supervisor-heartbeat",
        assignedTo: "hive-supervisor",
        title: "Hive supervisor heartbeat",
        brief: "(populated at run time)",
      })},
      true,
      NOW() - interval '1 minute',
      'test'
    )
  `;
}

async function seedAgingDecision(hiveId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO decisions (hive_id, title, context, priority, status, created_at)
    VALUES (
      ${hiveId},
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

function mockAgentReturning(actions: SupervisorActions): InvokeSupervisorAgent {
  return async () => ({
    output: [
      "Brief commentary from the supervisor agent.",
      "",
      "```json",
      JSON.stringify(actions, null, 2),
      "```",
    ].join("\n"),
    taskId: null,
    tokensInput: 240,
    tokensOutput: 90,
    costCents: 5,
  });
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedRoleTemplates();
  await seedHive(CLEAN_HIVE, "clean-hive");
  await seedHive(BUSY_HIVE, "busy-hive");
});

describe("supervisor heartbeat — end-to-end across all four slices", () => {
  it("slice 1+2: schedule-timer fires the heartbeat and a clean hive persists no row and invokes no agent", async () => {
    await seedHeartbeatSchedule(CLEAN_HIVE);

    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    // Slice 2: no supervisor_reports row for a clean hive.
    const reports = await sql`
      SELECT id FROM supervisor_reports WHERE hive_id = ${CLEAN_HIVE}
    `;
    expect(reports).toHaveLength(0);

    // Slice 2: the default agent must not have enqueued a hive-supervisor
    // task either — the short-circuit happens before invokeAgent runs.
    const supTasks = await sql`
      SELECT id FROM tasks WHERE assigned_to = 'hive-supervisor' AND hive_id = ${CLEAN_HIVE}
    `;
    expect(supTasks).toHaveLength(0);

    // Slice 1: the schedule itself must still advance — otherwise a stuck
    // heartbeat would refire every tick.
    const [sched] = await sql<{ last_run_at: Date; next_run_at: Date }[]>`
      SELECT last_run_at, next_run_at FROM schedules WHERE hive_id = ${CLEAN_HIVE}
    `;
    expect(sched.last_run_at).not.toBeNull();
    expect(sched.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("spend gate: repeated unchanged scheduled findings do not enqueue another supervisor agent task", async () => {
    await seedHeartbeatSchedule(BUSY_HIVE);
    await seedAgingDecision(BUSY_HIVE);

    const firstFired = await checkAndFireSchedules(sql);
    expect(firstFired).toBe(1);

    const firstReports = await sql<{ id: string }[]>`
      SELECT id FROM supervisor_reports WHERE hive_id = ${BUSY_HIVE}
    `;
    expect(firstReports).toHaveLength(1);

    const firstAgentTasks = await sql<{ id: string }[]>`
      SELECT id FROM tasks
      WHERE hive_id = ${BUSY_HIVE}
        AND assigned_to = 'hive-supervisor'
        AND created_by = 'dispatcher'
    `;
    expect(firstAgentTasks).toHaveLength(1);

    await sql`
      UPDATE schedules
      SET next_run_at = NOW() - interval '1 minute'
      WHERE hive_id = ${BUSY_HIVE}
    `;

    const secondFired = await checkAndFireSchedules(sql);
    expect(secondFired).toBe(1);

    const secondReports = await sql<{ id: string }[]>`
      SELECT id FROM supervisor_reports WHERE hive_id = ${BUSY_HIVE}
    `;
    expect(secondReports).toHaveLength(1);

    const secondAgentTasks = await sql<{ id: string }[]>`
      SELECT id FROM tasks
      WHERE hive_id = ${BUSY_HIVE}
        AND assigned_to = 'hive-supervisor'
        AND created_by = 'dispatcher'
    `;
    expect(secondAgentTasks).toHaveLength(1);

    const [sched] = await sql<{ last_run_at: Date; next_run_at: Date }[]>`
      SELECT last_run_at, next_run_at FROM schedules WHERE hive_id = ${BUSY_HIVE}
    `;
    expect(sched.last_run_at).not.toBeNull();
    expect(sched.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("slice 1+3+4: findings trigger runSupervisor → actions applied → /api/supervisor-reports returns the row with full shape", async () => {
    // Seed a finding-triggering condition (aging decision > 24h, pending).
    await seedAgingDecision(BUSY_HIVE);

    // Parent task so spawn_followup has a real originalTaskId to attach to.
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief)
      VALUES (
        ${PARENT_TASK_ID},
        ${BUSY_HIVE},
        'design-agent',
        'owner',
        'completed',
        'parent analysis task',
        'brief'
      )
    `;

    const actions: SupervisorActions = {
      summary: "Spawn a dev follow-up and log an insight.",
      findings_addressed: [],
      actions: [
        {
          kind: "spawn_followup",
          originalTaskId: PARENT_TASK_ID,
          assignedTo: "dev-agent",
          title: "Implement the analyst recommendation",
          brief: "Use the parent task's result_summary as input.",
        },
        {
          kind: "log_insight",
          category: "operations",
          content: "Aging decisions over 48h were observed in the scan window.",
        },
      ],
    };

    // Slice 3: full apply path with a mocked agent (schedule-timer's
    // default agent path is fire-and-forget and defers apply, so we must
    // drive runSupervisor directly to cover the apply branch end-to-end).
    const result = await runSupervisor(sql, BUSY_HIVE, {
      invokeAgent: mockAgentReturning(actions),
    });
    expect(result.skipped).toBe(false);
    expect(result.malformed).toBeUndefined();
    expect(result.deferred).toBeUndefined();
    expect(result.actionsApplied).toBe(2);
    expect(result.actionsErrored).toBe(0);
    expect(result.reportId).not.toBeNull();

    // Slice 4: read back through the HTTP route and validate the shape the
    // dashboard consumes. Exercise the limit cap as part of the same call.
    const res = await GET(
      new Request(
        `http://localhost/api/supervisor-reports?hiveId=${BUSY_HIVE}&limit=5`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        hiveId: string;
        ranAt: string;
        report: {
          hiveId: string;
          findings: Array<{ kind: string; severity: string; id: string }>;
          metrics: Record<string, number>;
        };
        actions: SupervisorActions;
        actionOutcomes: Array<{ status: string; detail: string }>;
        agentTaskId: string | null;
        tokensInput: number | null;
        tokensOutput: number | null;
        costCents: number | null;
      }>;
    };
    expect(body.data).toHaveLength(1);

    const row = body.data[0];
    expect(row.id).toBe(result.reportId);
    expect(row.hiveId).toBe(BUSY_HIVE);
    expect(row.tokensInput).toBe(240);
    expect(row.tokensOutput).toBe(90);
    expect(row.costCents).toBe(5);

    // The persisted report must include the aging_decision finding the
    // scan produced — proves the full chain from scan → persist → API is
    // carrying findings intact.
    expect(row.report.hiveId).toBe(BUSY_HIVE);
    expect(row.report.findings.length).toBeGreaterThanOrEqual(1);
    const agingKinds = row.report.findings.map((f) => f.kind);
    expect(agingKinds).toContain("aging_decision");
    expect(row.report.metrics.openDecisions).toBeGreaterThanOrEqual(1);

    // Actions round-trip through JSONB with shape preserved.
    expect(row.actions.actions).toHaveLength(2);
    expect(row.actions.actions[0]).toMatchObject({
      kind: "spawn_followup",
      assignedTo: "dev-agent",
      title: "Implement the analyst recommendation",
    });
    expect(row.actions.actions[1]).toMatchObject({
      kind: "log_insight",
      category: "operations",
    });

    // Outcomes array is ordered by action index and every action was
    // applied successfully.
    expect(row.actionOutcomes).toHaveLength(2);
    expect(row.actionOutcomes.every((o) => o.status === "applied")).toBe(true);

    // Follow-up task was materialised on the apply path.
    const [followup] = await sql<
      { title: string; assigned_to: string; parent_task_id: string | null }[]
    >`
      SELECT title, assigned_to, parent_task_id FROM tasks
      WHERE created_by = 'hive-supervisor' AND hive_id = ${BUSY_HIVE}
    `;
    expect(followup.title).toBe("Implement the analyst recommendation");
    expect(followup.assigned_to).toBe("dev-agent");
    expect(followup.parent_task_id).toBe(PARENT_TASK_ID);

    // log_insight lands in hive_memory.
    const [memoryRow] = await sql<{ category: string; content: string }[]>`
      SELECT category, content FROM hive_memory
      WHERE hive_id = ${BUSY_HIVE}
    `;
    expect(memoryRow.category).toBe("operations");
    expect(memoryRow.content).toMatch(/aging decisions/i);
  });

  it("slice 4: /api/supervisor-reports scopes results to hiveId and respects limit across real runSupervisor rows", async () => {
    // Two hives, two reports on one, one on the other. The limit parameter
    // must clip per-hive results without leaking cross-hive rows.
    await seedAgingDecision(BUSY_HIVE);
    await seedAgingDecision(CLEAN_HIVE);

    const noopActions: SupervisorActions = {
      summary: "No actionable follow-up.",
      findings_addressed: [],
      actions: [{ kind: "noop", reasoning: "log-only" }],
    };

    // Busy hive: two heartbeats. Second heartbeat will see the aging
    // decision has NOT been resolved (runSupervisor doesn't close the
    // decision on noop), so the scan will find it again and persist a
    // second row. That gives us two rows to exercise the limit param.
    await runSupervisor(sql, BUSY_HIVE, { invokeAgent: mockAgentReturning(noopActions) });
    await runSupervisor(sql, BUSY_HIVE, { invokeAgent: mockAgentReturning(noopActions) });
    await runSupervisor(sql, CLEAN_HIVE, { invokeAgent: mockAgentReturning(noopActions) });

    // Default limit returns everything for the busy hive.
    const resAll = await GET(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${BUSY_HIVE}`),
    );
    expect(resAll.status).toBe(200);
    const bodyAll = (await resAll.json()) as {
      data: Array<{ hiveId: string }>;
    };
    expect(bodyAll.data).toHaveLength(2);
    expect(bodyAll.data.every((r) => r.hiveId === BUSY_HIVE)).toBe(true);

    // Limit=1 clips to the newest.
    const resLimited = await GET(
      new Request(
        `http://localhost/api/supervisor-reports?hiveId=${BUSY_HIVE}&limit=1`,
      ),
    );
    const bodyLimited = (await resLimited.json()) as {
      data: Array<{ hiveId: string; ranAt: string }>;
    };
    expect(bodyLimited.data).toHaveLength(1);
    expect(bodyLimited.data[0].hiveId).toBe(BUSY_HIVE);

    // Clean hive results do not leak into busy-hive queries.
    const resOther = await GET(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${CLEAN_HIVE}`),
    );
    const bodyOther = (await resOther.json()) as {
      data: Array<{ hiveId: string }>;
    };
    expect(bodyOther.data).toHaveLength(1);
    expect(bodyOther.data[0].hiveId).toBe(CLEAN_HIVE);
  });
});
