import { describe, it, expect, beforeEach, vi } from "vitest";
import type { JSONValue } from "postgres";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { applySupervisorActions } from "@/supervisor/apply-actions";
import type {
  HiveHealthReport,
  SupervisorAction,
  SupervisorActions,
} from "@/supervisor/types";

/**
 * Applier tests exercise every SupervisorAction kind against the real test
 * database, plus the two safety caps the plan requires:
 *
 *   1. A maximum of 5 spawn_followup actions per heartbeat — the 6th and
 *      beyond must be skipped, not applied, so a misbehaving supervisor
 *      cannot flood the queue.
 *   2. A spawn_followup whose (assignedTo, title) matches any action
 *      recorded in a supervisor_reports row from the last 24h must be
 *      skipped — the dedupe window prevents a "heal the stall by spawning
 *      the same stalled task again" loop.
 *
 * **Governance-critical:** create_decision actions with tier 3 MUST insert
 * a decisions row with status='ea_review' (NEVER 'pending'). Per the
 * owner's feedback memory `decisions_via_ea_first`, every owner-facing
 * decision routes through the EA first; the EA is the buffer that
 * attempts autonomous resolution before paging the owner.
 */

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_HIVE_ID = "11111111-1111-1111-1111-111111111112";

async function seedRoleTemplates() {
  const slugs: Array<[string, string, string]> = [
    ["design-agent", "Design Agent", "executor"],
    ["research-analyst", "Research Analyst", "executor"],
    ["dev-agent", "Dev Agent", "executor"],
    ["infrastructure-agent", "Infrastructure Agent", "executor"],
    ["qa", "QA", "system"],
    ["doctor", "Doctor", "system"],
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

async function seedHive(id: string, slug: string) {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${id}, ${slug}, ${slug}, 'digital')
  `;
}

async function insertTask(
  id: string,
  hiveId: string,
  status = "pending",
  assignedTo = "dev-agent",
  title = "task",
): Promise<void> {
  await sql`
    INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief)
    VALUES (${id}, ${hiveId}, ${assignedTo}, 'owner', ${status}, ${title}, 'brief')
  `;
}

function pack(...actions: SupervisorAction[]): SupervisorActions {
  return {
    summary: "test payload",
    findings_addressed: [],
    actions,
  };
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

async function insertReportRow(
  hiveId: string,
  actionsJson: SupervisorActions,
  ageInterval: string,
): Promise<void> {
  const report = {
    hiveId,
    scannedAt: "2026-04-21T00:00:00.000Z",
    findings: [],
    metrics: {
      openTasks: 0,
      activeGoals: 0,
      openDecisions: 0,
      tasksCompleted24h: 0,
      tasksFailed24h: 0,
    },
  };
  await sql`
    INSERT INTO supervisor_reports (hive_id, report, actions, ran_at)
    VALUES (
      ${hiveId},
      ${sql.json(report)},
      ${sql.json(toJsonValue(actionsJson))},
      NOW() - ${ageInterval}::interval
    )
  `;
}

async function insertInitiativeSuppressionDecision(input: {
  hiveId: string;
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
      ${input.hiveId},
      'schedule',
      'schedule-fixture',
      'completed',
      NOW() - interval '5 minutes',
      NOW() - interval '4 minutes',
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
      ${input.hiveId},
      'schedule',
      ${`dormant-goal-next-task:${input.goalId}`},
      ${input.goalId},
      'suppress',
      'Seeded suppression decision.',
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

function reportWithDormantGoalSuppression(input: {
  hiveId: string;
  goalId: string;
  runId: string;
  suppressionReason: string;
}): HiveHealthReport {
  return {
    hiveId: input.hiveId,
    scannedAt: "2026-04-25T00:00:00.000Z",
    metrics: {
      openTasks: 0,
      activeGoals: 1,
      openDecisions: 0,
      tasksCompleted24h: 0,
      tasksFailed24h: 0,
    },
    findings: [
      {
        id: `dormant_goal:${input.goalId}`,
        kind: "dormant_goal",
        severity: "warn",
        ref: { goalId: input.goalId },
        summary: "Dormant goal",
        detail: {
          lastProgressAt: "2026-04-22T00:00:00.000Z",
          hoursSinceProgress: 72,
          initiative: {
            latestSuppression: {
              runId: input.runId,
              actionTaken: "suppress",
              suppressionReason: input.suppressionReason,
            },
          },
        },
      },
    ],
  };
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedRoleTemplates();
  await seedHive(HIVE_ID, "test-hive");
  await seedHive(OTHER_HIVE_ID, "other-hive");
});

describe.sequential("applySupervisorActions suites", () => {
describe.sequential("applySupervisorActions — per-kind outcomes", () => {
  it("applies noop as a structured 'applied' outcome", async () => {
    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({ kind: "noop", reasoning: "clean hive" }),
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("applied");
    expect(outcomes[0].detail).toMatch(/noop/i);
  });

  it("spawn_followup creates a new task with parent + hive-supervisor as creator", async () => {
    const parentId = "22222222-2222-2222-2222-222222222222";
    await insertTask(parentId, HIVE_ID, "completed", "design-agent", "analyse X");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: parentId,
        assignedTo: "dev-agent",
        title: "implement X from analysis",
        brief: "See parent task summary.",
      }),
    );
    expect(outcomes[0].status).toBe("applied");

    const rows = await sql<
      { id: string; parent_task_id: string | null; assigned_to: string; created_by: string }[]
    >`
      SELECT id, parent_task_id, assigned_to, created_by
      FROM tasks
      WHERE parent_task_id = ${parentId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].assigned_to).toBe("dev-agent");
    expect(rows[0].created_by).toBe("hive-supervisor");
  });

  it("spawn_followup sets qaRequired when requested", async () => {
    const parentId = "22222222-2222-2222-2222-222222222223";
    await insertTask(parentId, HIVE_ID, "completed");

    await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: parentId,
        assignedTo: "dev-agent",
        title: "implement + QA",
        brief: "brief",
        qaRequired: true,
      }),
    );

    const [row] = await sql<{ qa_required: boolean }[]>`
      SELECT qa_required FROM tasks WHERE parent_task_id = ${parentId}
    `;
    expect(row.qa_required).toBe(true);
  });

  it("close_task sets status='completed', appends note to result_summary, and clears stale failure_reason", async () => {
    const tid = "33333333-3333-3333-3333-333333333333";
    await insertTask(tid, HIVE_ID, "active");
    await sql`
      UPDATE tasks
      SET failure_reason = 'Doctor intervened after turn limit'
      WHERE id = ${tid}
    `;

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({ kind: "close_task", taskId: tid, note: "owner resolved offline" }),
    );
    expect(outcomes[0].status).toBe("applied");

    const [row] = await sql<{ status: string; result_summary: string | null; failure_reason: string | null }[]>`
      SELECT status, result_summary, failure_reason FROM tasks WHERE id = ${tid}
    `;
    expect(row.status).toBe("completed");
    expect(row.result_summary ?? "").toMatch(/owner resolved offline/);
    expect(row.failure_reason).toBeNull();
  });

  it("mark_unresolvable sets status='unresolvable' and writes reason", async () => {
    const tid = "44444444-4444-4444-4444-444444444444";
    await insertTask(tid, HIVE_ID, "active");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "mark_unresolvable",
        taskId: tid,
        reason: "role no longer exists",
      }),
    );
    expect(outcomes[0].status).toBe("applied");

    const [row] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${tid}
    `;
    expect(row.status).toBe("unresolvable");
    expect(row.failure_reason).toBe("role no longer exists");
  });

  it("log_insight inserts into hive_memory with the supplied category", async () => {
    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "log_insight",
        category: "operations",
        content: "Three stalls in one hour — adapter timeouts?",
      }),
    );
    expect(outcomes[0].status).toBe("applied");

    const rows = await sql<{ category: string; content: string }[]>`
      SELECT category, content FROM hive_memory
      WHERE hive_id = ${HIVE_ID}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("operations");
    expect(rows[0].content).toMatch(/adapter timeouts/);
  });

  it("records sanitized audit evidence for log_insight hive memory writes", async () => {
    const sensitiveMemory = "audit-regression raw stall detail must not appear";
    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "log_insight",
        category: "operations",
        content: sensitiveMemory,
      }),
    );
    expect(outcomes[0].status).toBe("applied");

    const [memory] = await sql<{ id: string }[]>`
      SELECT id FROM hive_memory
      WHERE hive_id = ${HIVE_ID}
        AND content = ${sensitiveMemory}
    `;
    const [audit] = await sql<{
      event_type: string;
      actor_label: string | null;
      hive_id: string | null;
      target_type: string;
      target_id: string | null;
      metadata: Record<string, unknown>;
    }[]>`
      SELECT event_type, actor_label, hive_id, target_type, target_id, metadata
      FROM agent_audit_events
      WHERE target_type = 'hive_memory'
        AND target_id = ${memory.id}
    `;

    expect(audit).toMatchObject({
      event_type: "hive_memory.written",
      actor_label: "hive-supervisor",
      hive_id: HIVE_ID,
      target_type: "hive_memory",
      target_id: memory.id,
    });
    expect(audit.metadata).toMatchObject({
      source: "supervisor.apply_actions",
      actionKind: "log_insight",
      memoryId: memory.id,
      category: "operations",
      sensitivity: "internal",
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(sensitiveMemory);
  });

  it("wake_goal updates the goal to force re-detection by lifecycle poll", async () => {
    const goalId = "55555555-5555-5555-5555-555555555555";
    await sql`
      INSERT INTO goals (id, hive_id, title, status, last_woken_sprint)
      VALUES (${goalId}, ${HIVE_ID}, 'dormant goal', 'active', 3)
    `;

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "wake_goal",
        goalId,
        reasoning: "no activity 48h",
      }),
    );
    expect(outcomes[0].status).toBe("applied");

    const [row] = await sql<{ last_woken_sprint: number | null }[]>`
      SELECT last_woken_sprint FROM goals WHERE id = ${goalId}
    `;
    // Roll the marker back so the goal's next completed sprint re-wakes.
    expect(row.last_woken_sprint === null || row.last_woken_sprint < 3).toBe(true);
  });

  it("skips wake_goal when the same run suppressed that goal with per_run_cap", async () => {
    const goalId = "55555555-5555-5555-5555-555555555556";
    const runId = "66666666-6666-6666-6666-666666666666";
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await sql`
      INSERT INTO goals (id, hive_id, title, status, last_woken_sprint)
      VALUES (${goalId}, ${HIVE_ID}, 'suppressed goal', 'active', 3)
    `;
    await insertInitiativeSuppressionDecision({
      hiveId: HIVE_ID,
      runId,
      goalId,
      suppressionReason: "per_run_cap",
    });

    try {
      const outcomes = await applySupervisorActions(
        sql,
        HIVE_ID,
        pack({
          kind: "wake_goal",
          goalId,
          reasoning: "retry dormant goal",
        }),
        {
          report: reportWithDormantGoalSuppression({
            hiveId: HIVE_ID,
            goalId,
            runId,
            suppressionReason: "per_run_cap",
          }),
        },
      );
      expect(outcomes[0].status).toBe("skipped");
      expect(outcomes[0].detail).toMatch(/per_run_cap/);
      expect(outcomes[0].detail).toContain(runId);
      expect(infoSpy).toHaveBeenCalledWith(
        "[supervisor] wake_goal skipped by same-run suppression",
        {
          goalId,
          runId,
          suppressionReason: "per_run_cap",
        },
      );

      const [row] = await sql<{ last_woken_sprint: number | null }[]>`
        SELECT last_woken_sprint FROM goals WHERE id = ${goalId}
      `;
      expect(row.last_woken_sprint).toBe(3);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("allows wake_goal when the same run suppression reason is not per_run_cap", async () => {
    const goalId = "55555555-5555-5555-5555-555555555557";
    const runId = "77777777-7777-7777-7777-777777777777";
    await sql`
      INSERT INTO goals (id, hive_id, title, status, last_woken_sprint)
      VALUES (${goalId}, ${HIVE_ID}, 'cooldown goal', 'active', 4)
    `;
    await insertInitiativeSuppressionDecision({
      hiveId: HIVE_ID,
      runId,
      goalId,
      suppressionReason: "cooldown_active",
    });

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "wake_goal",
        goalId,
        reasoning: "review cooldown goal",
      }),
      {
        report: reportWithDormantGoalSuppression({
          hiveId: HIVE_ID,
          goalId,
          runId,
          suppressionReason: "cooldown_active",
        }),
      },
    );
    expect(outcomes[0].status).toBe("applied");

    const [row] = await sql<{ last_woken_sprint: number | null }[]>`
      SELECT last_woken_sprint FROM goals WHERE id = ${goalId}
    `;
    expect(row.last_woken_sprint === null || row.last_woken_sprint < 4).toBe(true);
  });

  it("returns status='error' for actions that reference a missing task without aborting the batch", async () => {
    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack(
        {
          kind: "close_task",
          taskId: "99999999-9999-9999-9999-999999999999",
          note: "does not exist",
        },
        { kind: "noop", reasoning: "still applied after the error above" },
      ),
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe("error");
    expect(outcomes[1].status).toBe("applied");
  });
});

describe.sequential("applySupervisorActions — EA-first decision routing (governance)", () => {
  it("create_decision tier 3 routes to status='ea_review' (NEVER pending)", async () => {
    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "create_decision",
        tier: 3,
        title: "Owner input needed — repeated dev-agent timeouts",
        context: "3 recurring failures in the last 24h",
        recommendation: "Pause the sprint while we investigate.",
      }),
    );
    expect(outcomes[0].status).toBe("applied");

    const rows = await sql<
      { status: string; priority: string; title: string; kind: string }[]
    >`
      SELECT status, priority, title, kind FROM decisions WHERE hive_id = ${HIVE_ID}
    `;
    expect(rows).toHaveLength(1);
    // Governance-critical: tier 3 MUST NOT insert a `pending` row directly.
    expect(rows[0].status).toBe("ea_review");
    expect(rows[0].status).not.toBe("pending");
  });

  it("create_decision tier 2 also routes to 'ea_review'", async () => {
    await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "create_decision",
        tier: 2,
        title: "Flagged for EA review",
        context: "Aging aging_decision finding",
      }),
    );
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM decisions WHERE hive_id = ${HIVE_ID}
    `;
    expect(rows[0].status).toBe("ea_review");
  });

  it("records sanitized audit evidence for direct create_decision actions", async () => {
    const sensitiveContext = "audit-regression raw decision context must not appear";
    const sensitiveRecommendation = "audit-regression raw recommendation must not appear";
    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "create_decision",
        tier: 3,
        title: "Audit covered supervisor decision",
        context: sensitiveContext,
        recommendation: sensitiveRecommendation,
        options: [
          { key: "pause", label: "Pause", response: "approved" },
          { key: "continue", label: "Continue", response: "rejected" },
        ],
      }),
    );
    expect(outcomes[0].status).toBe("applied");

    const [decision] = await sql<{ id: string; status: string; priority: string; kind: string }[]>`
      SELECT id, status, priority, kind
      FROM decisions
      WHERE hive_id = ${HIVE_ID}
        AND title = 'Audit covered supervisor decision'
    `;
    const [audit] = await sql<{
      event_type: string;
      actor_label: string | null;
      hive_id: string | null;
      target_type: string;
      target_id: string | null;
      metadata: Record<string, unknown>;
    }[]>`
      SELECT event_type, actor_label, hive_id, target_type, target_id, metadata
      FROM agent_audit_events
      WHERE target_type = 'decision'
        AND target_id = ${decision.id}
    `;

    expect(decision.status).toBe("ea_review");
    expect(audit).toMatchObject({
      event_type: "decision.created",
      actor_label: "hive-supervisor",
      hive_id: HIVE_ID,
      target_type: "decision",
      target_id: decision.id,
    });
    expect(audit.metadata).toMatchObject({
      source: "supervisor.apply_actions",
      actionKind: "create_decision",
      decisionId: decision.id,
      tier: 3,
      status: "ea_review",
      priority: "urgent",
      kind: "supervisor_flagged",
      optionCount: 2,
      contextProvided: true,
      recommendationProvided: true,
    });
    const metadata = JSON.stringify(audit.metadata);
    expect(metadata).not.toContain(sensitiveContext);
    expect(metadata).not.toContain(sensitiveRecommendation);
  });

  it("create_decision preserves structured named options", async () => {
    await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "create_decision",
        tier: 3,
        title: "Choose Gemini CLI auth path",
        context: "The adapter needs a runtime auth path.",
        recommendation: "Use GCA login.",
        options: [
          {
            key: "api-key-runtime",
            label: "Use Gemini API key runtime",
            consequence: "Fast but stores a credential.",
            response: "approved",
          },
          {
            key: "gca-login",
            label: "Use GCA login",
            consequence: "Owner can select this directly instead of using Discuss.",
            response: "approved",
          },
          {
            key: "defer-gemini-adapter",
            label: "Defer Gemini adapter work",
            consequence: "Leaves the goal parked.",
            canonicalResponse: "rejected",
          },
        ],
      }),
    );
    const [row] = await sql<{ options: { key: string; label: string; response?: string; canonicalResponse?: string }[] }[]>`
      SELECT options FROM decisions WHERE hive_id = ${HIVE_ID}
    `;
    expect(row.options).toEqual([
      expect.objectContaining({ key: "api-key-runtime", label: "Use Gemini API key runtime" }),
      expect.objectContaining({ key: "gca-login", label: "Use GCA login", response: "approved" }),
      expect.objectContaining({ key: "defer-gemini-adapter", canonicalResponse: "rejected" }),
    ]);
  });

  it("NO supervisor-created decision row ever has status='pending'", async () => {
    await applySupervisorActions(
      sql,
      HIVE_ID,
      pack(
        {
          kind: "create_decision",
          tier: 3,
          title: "t3 decision",
          context: "c",
        },
        {
          kind: "create_decision",
          tier: 2,
          title: "t2 decision",
          context: "c",
        },
      ),
    );
    const [{ pending }] = await sql<{ pending: number }[]>`
      SELECT COUNT(*)::int AS pending
      FROM decisions WHERE hive_id = ${HIVE_ID} AND status = 'pending'
    `;
    expect(pending).toBe(0);
  });

  it("dedupes repeated supervisor create_decision actions into one EA review item", async () => {
    const action: SupervisorAction = {
      kind: "create_decision",
      tier: 3,
      title: "Recurring dev-agent timeouts require EA triage",
      context: "The same recurring_failure finding is still present.",
      recommendation: "Review the blocked runtime route before spawning more work.",
      options: [
        {
          key: "pause-runtime",
          label: "Pause runtime work",
          response: "approved",
        },
      ],
    };

    const first = await applySupervisorActions(sql, HIVE_ID, pack(action));
    const second = await applySupervisorActions(sql, HIVE_ID, pack(action));

    expect(first[0].status).toBe("applied");
    expect(second[0].status).toBe("skipped");
    expect(second[0].detail).toMatch(/duplicate|dedupe|EA review/i);

    const [{ decisions }] = await sql<{ decisions: number }[]>`
      SELECT COUNT(*)::int AS decisions
      FROM decisions
      WHERE hive_id = ${HIVE_ID}
        AND kind = 'supervisor_flagged'
    `;
    expect(decisions).toBe(1);

    const [{ notifications }] = await sql<{ notifications: number }[]>`
      SELECT COUNT(*)::int AS notifications
      FROM outbound_notifications
      WHERE hive_id = ${HIVE_ID}
    `;
    expect(notifications).toBe(0);
  });
});

describe.sequential("applySupervisorActions — bounded remediation validation", () => {
  it("skips spawn_followup when the assigned role does not exist", async () => {
    const parentId = "88888888-8888-8888-8888-888888888880";
    await insertTask(parentId, HIVE_ID, "completed", "design-agent", "analyse unsafe role");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: parentId,
        assignedTo: "not-a-real-role",
        title: "implement unsafe role assignment",
        brief: "brief",
      }),
    );

    expect(outcomes[0].status).toBe("skipped");
    expect(outcomes[0].detail).toMatch(/role|assignedTo/i);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM tasks WHERE parent_task_id = ${parentId}
    `;
    expect(count).toBe(0);
  });

  it("skips spawn_followup when title or brief exceed bounded remediation limits", async () => {
    const parentId = "88888888-8888-8888-8888-888888888881";
    await insertTask(parentId, HIVE_ID, "completed", "design-agent", "analyse oversized follow-up");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: parentId,
        assignedTo: "dev-agent",
        title: "x".repeat(300),
        brief: "y".repeat(5000),
      }),
    );

    expect(outcomes[0].status).toBe("skipped");
    expect(outcomes[0].detail).toMatch(/title|brief|too long|bounded/i);
  });

  it("skips terminal task mutations for close_task and mark_unresolvable", async () => {
    const completedId = "88888888-8888-8888-8888-888888888882";
    const cancelledId = "88888888-8888-8888-8888-888888888883";
    await insertTask(completedId, HIVE_ID, "completed", "dev-agent", "already complete");
    await insertTask(cancelledId, HIVE_ID, "cancelled", "dev-agent", "already cancelled");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack(
        {
          kind: "close_task",
          taskId: completedId,
          note: "should not append to terminal task",
        },
        {
          kind: "mark_unresolvable",
          taskId: cancelledId,
          reason: "should not change terminal task",
        },
      ),
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "skipped"]);
    expect(outcomes[0].detail).toMatch(/terminal|completed/i);
    expect(outcomes[1].detail).toMatch(/terminal|cancelled/i);

    const rows = await sql<{ id: string; status: string; failure_reason: string | null; result_summary: string | null }[]>`
      SELECT id, status, failure_reason, result_summary
      FROM tasks
      WHERE id IN (${completedId}, ${cancelledId})
      ORDER BY id
    `;
    expect(rows.find((row) => row.id === completedId)?.status).toBe("completed");
    expect(rows.find((row) => row.id === completedId)?.result_summary).toBeNull();
    expect(rows.find((row) => row.id === cancelledId)?.status).toBe("cancelled");
    expect(rows.find((row) => row.id === cancelledId)?.failure_reason).toBeNull();
  });

  it("skips wake_goal for inactive goals", async () => {
    const goalId = "88888888-8888-8888-8888-888888888884";
    await sql`
      INSERT INTO goals (id, hive_id, title, status, last_woken_sprint)
      VALUES (${goalId}, ${HIVE_ID}, 'achieved goal', 'achieved', 9)
    `;

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "wake_goal",
        goalId,
        reasoning: "should not wake achieved work",
      }),
    );

    expect(outcomes[0].status).toBe("skipped");
    expect(outcomes[0].detail).toMatch(/active|status|achieved/i);

    const [row] = await sql<{ last_woken_sprint: number | null }[]>`
      SELECT last_woken_sprint FROM goals WHERE id = ${goalId}
    `;
    expect(row.last_woken_sprint).toBe(9);
  });

  it("skips oversized create_decision and log_insight actions", async () => {
    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack(
        {
          kind: "create_decision",
          tier: 2,
          title: "x".repeat(300),
          context: "c".repeat(5000),
        },
        {
          kind: "log_insight",
          category: "operations",
          content: "i".repeat(5000),
        },
      ),
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "skipped"]);
    expect(outcomes[0].detail).toMatch(/title|context|too long|bounded/i);
    expect(outcomes[1].detail).toMatch(/content|too long|bounded/i);

    const [{ decisions }] = await sql<{ decisions: number }[]>`
      SELECT COUNT(*)::int AS decisions FROM decisions WHERE hive_id = ${HIVE_ID}
    `;
    const [{ memories }] = await sql<{ memories: number }[]>`
      SELECT COUNT(*)::int AS memories FROM hive_memory WHERE hive_id = ${HIVE_ID}
    `;
    expect(decisions).toBe(0);
    expect(memories).toBe(0);
  });
});

describe.sequential("applySupervisorActions — safety caps", () => {
  it("applies at most 5 spawn_followup per heartbeat; 6th+ skipped with cap detail", async () => {
    const parents: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `66666666-6666-6666-6666-66666666666${i}`;
      await insertTask(id, HIVE_ID, "completed", "design-agent", `analyse ${i}`);
      parents.push(id);
    }

    const actions: SupervisorAction[] = parents.map((pid, i) => ({
      kind: "spawn_followup",
      originalTaskId: pid,
      assignedTo: "dev-agent",
      title: `implement ${i}`,
      brief: "b",
    }));

    const outcomes = await applySupervisorActions(sql, HIVE_ID, pack(...actions));
    const applied = outcomes.filter((o) => o.status === "applied").length;
    const skipped = outcomes.filter((o) => o.status === "skipped").length;
    expect(applied).toBe(5);
    expect(skipped).toBe(1);
    const lastSkipped = outcomes[outcomes.length - 1];
    expect(lastSkipped.status).toBe("skipped");
    expect(lastSkipped.detail).toMatch(/cap|limit|5/i);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM tasks
      WHERE hive_id = ${HIVE_ID} AND created_by = 'hive-supervisor'
    `;
    expect(count).toBe(5);
  });

  it("skips a spawn_followup whose (assignedTo, title) matches a prior supervisor_reports row in the last 24h", async () => {
    // Pre-seed a supervisor report from 1h ago that already spawned
    // "dev-agent / implement honeycomb palette".
    await insertReportRow(
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: "00000000-0000-0000-0000-000000000001",
        assignedTo: "dev-agent",
        title: "implement honeycomb palette",
        brief: "(earlier heartbeat)",
      }),
      "1 hour",
    );

    const parentId = "77777777-7777-7777-7777-777777777777";
    await insertTask(parentId, HIVE_ID, "completed", "design-agent", "analyse palette");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: parentId,
        assignedTo: "dev-agent",
        title: "implement honeycomb palette",
        brief: "(this heartbeat)",
      }),
    );
    expect(outcomes[0].status).toBe("skipped");
    expect(outcomes[0].detail).toMatch(/duplicate|dedupe|24h/i);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM tasks WHERE parent_task_id = ${parentId}
    `;
    expect(count).toBe(0);
  });

  it("skips a spawn_followup whose (assignedTo, title) already materialized as a hive-supervisor task", async () => {
    const firstParentId = "77777777-7777-7777-7777-777777777780";
    const retryParentId = "77777777-7777-7777-7777-777777777781";
    await insertTask(firstParentId, HIVE_ID, "completed", "design-agent", "first parent");
    await insertTask(retryParentId, HIVE_ID, "completed", "design-agent", "retry parent");
    await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, status, title, brief,
        parent_task_id, qa_required
      )
      VALUES (
        ${HIVE_ID}, 'dev-agent', 'hive-supervisor', 'pending',
        'implement partial-registration retry', 'created before report persisted',
        ${firstParentId}, false
      )
    `;

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: retryParentId,
        assignedTo: "dev-agent",
        title: "implement partial-registration retry",
        brief: "retry should not duplicate the already-created task",
      }),
    );
    expect(outcomes[0].status).toBe("skipped");
    expect(outcomes[0].detail).toMatch(/duplicate|dedupe|24h/i);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM tasks
      WHERE hive_id = ${HIVE_ID}
        AND created_by = 'hive-supervisor'
        AND assigned_to = 'dev-agent'
        AND title = 'implement partial-registration retry'
    `;
    expect(count).toBe(1);
  });

  it("does NOT dedupe against prior reports older than 24h (window expires)", async () => {
    await insertReportRow(
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: "00000000-0000-0000-0000-000000000002",
        assignedTo: "dev-agent",
        title: "implement honeycomb palette",
        brief: "(very old heartbeat)",
      }),
      "25 hours",
    );

    const parentId = "77777777-7777-7777-7777-777777777778";
    await insertTask(parentId, HIVE_ID, "completed", "design-agent", "analyse palette");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: parentId,
        assignedTo: "dev-agent",
        title: "implement honeycomb palette",
        brief: "(current heartbeat)",
      }),
    );
    expect(outcomes[0].status).toBe("applied");
  });

  it("does NOT dedupe against another hive's prior report (hive isolation)", async () => {
    // Prior spawn in OTHER_HIVE — must NOT block HIVE_ID from spawning.
    await insertReportRow(
      OTHER_HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: "00000000-0000-0000-0000-000000000003",
        assignedTo: "dev-agent",
        title: "implement honeycomb palette",
        brief: "(different hive)",
      }),
      "1 hour",
    );

    const parentId = "77777777-7777-7777-7777-777777777779";
    await insertTask(parentId, HIVE_ID, "completed", "design-agent", "analyse palette");

    const outcomes = await applySupervisorActions(
      sql,
      HIVE_ID,
      pack({
        kind: "spawn_followup",
        originalTaskId: parentId,
        assignedTo: "dev-agent",
        title: "implement honeycomb palette",
        brief: "(current heartbeat)",
      }),
    );
    expect(outcomes[0].status).toBe("applied");
  });
});
});
