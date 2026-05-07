import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";
import { runInitiativeEvaluation } from "@/initiative-engine";
import { seedDormantGoalTestFixture } from "./dormant-goal-test-fixture";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let staleGoalId: string;
let secondGoalId: string;
let scheduleId: string;

async function submitWorkDirect(input: {
  hiveId: string;
  input: string;
  projectId?: string | null;
  goalId?: string | null;
  priority: number;
  acceptanceCriteria: string;
}) {
  const [task] = await sql<Array<{ id: string; title: string }>>`
    INSERT INTO tasks (
      hive_id,
      goal_id,
      title,
      brief,
      status,
      assigned_to,
      created_by,
      acceptance_criteria,
      priority,
      qa_required,
      project_id
    )
    VALUES (
      ${input.hiveId},
      ${input.goalId ?? null},
      'Restart dormant goal',
      ${input.input},
      'pending',
      'dev-agent',
      'initiative-engine',
      ${input.acceptanceCriteria},
      ${input.priority},
      false,
      ${input.projectId ?? null}
    )
    RETURNING id, title
  `;

  return {
    id: task.id,
    type: "task" as const,
    title: task.title,
    classification: {
      provider: "test-provider",
      model: "test-model",
      confidence: 0.9,
      reasoning: "task classification",
      usedFallback: false,
    },
  };
}

beforeEach(async () => {
  await truncateAll(sql);
  const fixture = await seedDormantGoalTestFixture(sql, {
    hiveSlugPrefix: "initiative-hive",
    hiveName: "Initiative Hive",
  });
  hiveId = fixture.hiveId;
  staleGoalId = fixture.primaryGoalId;
  secondGoalId = fixture.secondaryGoalId;
  scheduleId = fixture.scheduleId;
});

afterEach(() => {
  delete process.env.INTERNAL_SERVICE_TOKEN;
  vi.unstubAllGlobals();
});

describe.sequential("runInitiativeEvaluation", () => {
  it("creates one dormant-goal follow-up and records the classifier response in outcome evidence", async () => {
    const classification = {
      provider: "test-provider",
      model: "test-model",
      confidence: 0.91,
      reasoning: "task classification",
      usedFallback: false,
    };

    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, {
      submitWork: async (input) => {
        const [task] = await sql<Array<{ id: string; title: string; assigned_to: string }>>`
          INSERT INTO tasks (
            hive_id,
            goal_id,
            title,
            brief,
            status,
            assigned_to,
            created_by,
            acceptance_criteria,
            priority,
            qa_required
          )
          VALUES (
            ${input.hiveId},
            ${input.goalId ?? null},
            'Restart onboarding goal',
            ${input.input},
            'pending',
            'dev-agent',
            'initiative-engine',
            ${input.acceptanceCriteria},
            ${input.priority},
            false
          )
          RETURNING id, title, assigned_to
        `;

        return {
          id: task.id,
          type: "task",
          title: task.title,
          classification,
        };
      },
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(result.candidatesEvaluated).toBe(2);

    const createdOutcome = result.outcomes.find((outcome) => outcome.actionTaken === "create_task");
    const suppressedOutcome = result.outcomes.find((outcome) => outcome.goalId === secondGoalId);

    expect(createdOutcome?.createdTaskId).toBeTruthy();
    expect(createdOutcome?.evidence).toMatchObject({
      candidate: {
        kind: "dormant-goal-next-task",
        goalId: staleGoalId,
      },
      creation: {
        workItemId: createdOutcome?.createdTaskId,
        workItemType: "task",
        classification,
      },
    });
    expect((createdOutcome?.evidence as { assignee?: unknown }).assignee).toBeUndefined();
    expect(suppressedOutcome?.actionTaken).toBe("suppress");

    const [task] = await sql<Array<{ goal_id: string; created_by: string; assigned_to: string }>>`
      SELECT goal_id, created_by, assigned_to
      FROM tasks
      WHERE id = ${createdOutcome!.createdTaskId!}
    `;
    expect(task).toMatchObject({
      goal_id: staleGoalId,
      created_by: "initiative-engine",
      assigned_to: "dev-agent",
    });

    const [decision] = await sql<Array<{ action_taken: string; evidence: unknown }>>`
      SELECT action_taken, evidence
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
        AND candidate_ref = ${staleGoalId}
      LIMIT 1
    `;
    expect(decision.action_taken).toBe("create_task");
    expect(decision.evidence).toMatchObject({
      creation: {
        classification,
      },
    });
  });

  it("preserves goal classifications returned by the work intake API", async () => {
    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, {
      submitWork: async (input) => {
        const [goal] = await sql<Array<{ id: string; title: string }>>`
          INSERT INTO goals (hive_id, title, description, project_id)
          VALUES (
            ${input.hiveId},
            'New dormant-goal recovery goal',
            ${input.input},
            ${input.projectId ?? null}
          )
          RETURNING id, title
        `;

        return {
          id: goal.id,
          type: "goal" as const,
          title: goal.title,
          classification: {
            provider: "test-provider",
            model: "test-model",
            confidence: 0.52,
            reasoning: "defaulted to goal",
            usedFallback: true,
          },
        };
      },
    });

    const createdOutcome = result.outcomes.find((outcome) => outcome.actionTaken === "create_goal");
    expect(createdOutcome).toMatchObject({
      actionTaken: "create_goal",
      createdTaskId: null,
      evidence: {
        creation: {
          workItemType: "goal",
          classification: {
            provider: "test-provider",
            model: "test-model",
            confidence: 0.52,
            reasoning: "defaulted to goal",
            usedFallback: true,
          },
        },
      },
    });
    expect(createdOutcome?.createdGoalId).toBeTruthy();
    expect((createdOutcome?.evidence as { creation?: { workItemId?: string } }).creation?.workItemId)
      .toBe(createdOutcome?.createdGoalId);
  });

  it("supports an initiative schedule scoped to a single target goal", async () => {
    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: {
        kind: "schedule",
        scheduleId,
        targetGoalId: secondGoalId,
      },
    }, {
      submitWork: submitWorkDirect,
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.suppressed).toBe(0);
    expect(result.candidatesEvaluated).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      actionTaken: "create_task",
      goalId: secondGoalId,
      evidence: {
        scope: {
          mode: "single_goal",
          targetGoalId: secondGoalId,
          targetGoalTitle: "Second dormant goal",
          targetFrozen: true,
          excludedAlternateDormantGoalCount: 1,
        },
      },
    });

    const [run] = await sql<Array<{
      guardrail_config: {
        targetGoalId?: string | null;
        targetGoalScope?: string | null;
        targetGoalTitle?: string | null;
        excludedAlternateDormantGoalCount?: number | null;
        maxOpenTasksBeforeSuppress?: number;
      };
    }>>`
      SELECT guardrail_config
      FROM initiative_runs
      WHERE id = ${result.runId}
    `;
    expect(run.guardrail_config).toMatchObject({
      targetGoalId: secondGoalId,
      targetGoalScope: "single_goal",
      targetGoalTitle: "Second dormant goal",
      excludedAlternateDormantGoalCount: 1,
    });
    expect("targetRole" in run.guardrail_config).toBe(false);

    const decisions = await sql<Array<{ candidate_ref: string | null }>>`
      SELECT candidate_ref
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
    `;
    expect(decisions).toEqual([{ candidate_ref: secondGoalId }]);
  });

  it("suppresses the same candidate on a second evaluation inside the cooldown window", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Parameters<typeof submitWorkDirect>[0];
      const created = await submitWorkDirect(body);
      return new Response(JSON.stringify({ data: created }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.INTERNAL_SERVICE_TOKEN = "initiative-token";

    const first = await checkAndFireSchedules(sql);
    expect(first).toBe(1);

    await sql`
      UPDATE tasks
      SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE goal_id = ${staleGoalId}
        AND created_by = 'initiative-engine'
    `;

    await sql`
      UPDATE schedules
      SET next_run_at = NOW() - interval '1 minute'
      WHERE id = ${scheduleId}
    `;

    const second = await checkAndFireSchedules(sql);
    expect(second).toBe(1);

    const cooldownRuns = await sql<Array<{
      action_taken: string;
      rationale: string;
      dedupe_key: string;
      suppression_reason: string | null;
      evidence: { suppression?: { reason?: string } };
    }>>`
      SELECT action_taken, rationale, dedupe_key, suppression_reason, evidence
      FROM initiative_run_decisions
      WHERE hive_id = ${hiveId}
        AND candidate_ref = ${staleGoalId}
      ORDER BY created_at ASC
    `;

    expect(cooldownRuns).toHaveLength(2);
    expect(cooldownRuns[0].action_taken).toBe("create_task");
    expect(cooldownRuns[1]).toMatchObject({
      action_taken: "suppress",
      dedupe_key: `dormant-goal-next-task:${staleGoalId}`,
      suppression_reason: "cooldown_active",
      evidence: {
        suppression: {
          reason: "cooldown_active",
        },
      },
    });
    expect(cooldownRuns[1].rationale).toMatch(/cooldown window/i);
  });

  it("suppresses duplicate restart creation when the dormant goal already has an open non-initiative task", async () => {
    await sql`
      INSERT INTO tasks (
        hive_id,
        goal_id,
        title,
        brief,
        status,
        assigned_to,
        created_by,
        acceptance_criteria,
        priority,
        qa_required
      )
      VALUES (
        ${hiveId},
        ${staleGoalId},
        'Sprint 1: Inspect technical assets and restart path',
        'Inspect the current technical assets and identify the narrowest safe restart path.',
        'active',
        'dev-agent',
        'goal-supervisor',
        'Summarize the technical restart path without duplicating ongoing work.',
        3,
        false
      )
    `;

    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, {
      submitWork: submitWorkDirect,
    });

    const staleGoalOutcome = result.outcomes.find((outcome) => outcome.goalId === staleGoalId);
    const secondGoalOutcome = result.outcomes.find((outcome) => outcome.goalId === secondGoalId);

    expect(staleGoalOutcome).toMatchObject({
      actionTaken: "suppress",
      suppressionReason: "existing_goal_task",
    });
    expect(secondGoalOutcome?.actionTaken).toBe("create_task");

    const [decision] = await sql<Array<{
      action_taken: string;
      suppression_reason: string | null;
      evidence: { suppression?: { reason?: string; taskId?: string; createdBy?: string } };
    }>>`
      SELECT action_taken, suppression_reason, evidence
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
        AND candidate_ref = ${staleGoalId}
      LIMIT 1
    `;

    expect(decision).toMatchObject({
      action_taken: "suppress",
      suppression_reason: "existing_goal_task",
      evidence: {
        suppression: {
          reason: "existing_goal_task",
          createdBy: "goal-supervisor",
        },
      },
    });
  });

  it("suppresses new initiative creation once the hive is saturated with open work", async () => {
    for (let i = 0; i < 12; i += 1) {
      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
        VALUES (${hiveId}, 'dev-agent', 'test', ${`busy-${i}`}, 'busy', 'pending')
      `;
    }

    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, {
      submitWork: submitWorkDirect,
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.suppressed).toBe(2);
    expect(result.outcomes.every((outcome) => outcome.suppressionReason === "queue_saturated")).toBe(true);
  });

  it("blocks new initiative creation once the daily cap has already been used", async () => {
    await sql`
      INSERT INTO initiative_runs (
        hive_id, trigger_type, status, started_at, completed_at,
        evaluated_candidates, created_count, created_goals, created_tasks,
        created_decisions, suppressed_count, noop_count, suppression_reasons,
        guardrail_config, run_failures, failure_reason
      )
      VALUES (
        ${hiveId},
        'schedule',
        'completed',
        NOW() - interval '2 hours',
        NOW() - interval '119 minutes',
        1,
        2,
        0,
        2,
        0,
        0,
        0,
        ${sql.json({})},
        ${sql.json({ perDayCap: 2 })},
        0,
        NULL
      )
      RETURNING id
    `;

    const [priorRun] = await sql<Array<{ id: string }>>`
      SELECT id
      FROM initiative_runs
      WHERE hive_id = ${hiveId}
      ORDER BY started_at ASC
      LIMIT 1
    `;

    await sql`
      INSERT INTO initiative_run_decisions (
        run_id, hive_id, trigger_type, candidate_key, candidate_ref,
        action_taken, rationale, dedupe_key, cooldown_hours,
        per_run_cap, per_day_cap, evidence, created_task_id
      )
      VALUES
      (
        ${priorRun.id},
        ${hiveId},
        'schedule',
        'seeded-1',
        'seeded-goal-1',
        'create_task',
        'Seeded first created item for per-day cap test.',
        'seeded-1',
        24,
        1,
        2,
        ${sql.json({ seeded: true })},
        NULL
      ),
      (
        ${priorRun.id},
        ${hiveId},
        'schedule',
        'seeded-2',
        'seeded-goal-2',
        'create_task',
        'Seeded second created item for per-day cap test.',
        'seeded-2',
        24,
        1,
        2,
        ${sql.json({ seeded: true })},
        NULL
      )
    `;

    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, {
      submitWork: submitWorkDirect,
    });

    expect(result.tasksCreated).toBe(0);
    expect(result.suppressed).toBeGreaterThan(0);
    expect(result.outcomes[0]).toMatchObject({
      actionTaken: "suppress",
      suppressionReason: "per_day_cap",
    });
  });

  it("suppresses autonomous creation when the generated work is above the allowed sensitivity level", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sql`
      UPDATE goals
      SET description = 'Investigate credential leak. password: topsecret123'
      WHERE hive_id = ${hiveId}
    `;

    try {
      const result = await runInitiativeEvaluation(sql, {
        hiveId,
        trigger: { kind: "schedule", scheduleId },
      }, {
        submitWork: submitWorkDirect,
      });

      expect(result.tasksCreated).toBe(0);
      expect(result.suppressed).toBe(2);
      expect(result.outcomes.every((outcome) => outcome.suppressionReason === "policy_blocked_sensitivity")).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0]?.[0]).toBe("[initiative-policy] blocked autonomous work creation");
      expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
        hiveId,
        goalId: staleGoalId,
        decision: "suppress",
        reason: "policy_blocked_sensitivity",
        sensitivity: "restricted",
        escalationPath: "owner_review_required",
      });
      expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty("assignedTo");
    } finally {
      warnSpy.mockRestore();
    }

    const [decision] = await sql<Array<{
      action_taken: string;
      suppression_reason: string | null;
      evidence: {
        policy?: { sensitivity?: string };
        suppression?: { reason?: string; escalationPath?: string; assignedTo?: string };
      };
    }>>`
      SELECT action_taken, suppression_reason, evidence
      FROM initiative_run_decisions
      WHERE hive_id = ${hiveId}
      ORDER BY created_at ASC
      LIMIT 1
    `;

    expect(decision).toMatchObject({
      action_taken: "suppress",
      suppression_reason: "policy_blocked_sensitivity",
      evidence: {
        policy: {
          sensitivity: "restricted",
        },
        suppression: {
          reason: "policy_blocked_sensitivity",
          escalationPath: "owner_review_required",
        },
      },
    });
    expect(decision.evidence.suppression?.assignedTo).toBeUndefined();
  });

  it("submits initiative-created work through authenticated /api/work without assignedTo pre-pinning", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "initiative-token";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Parameters<typeof submitWorkDirect>[0];
      const created = await submitWorkDirect(body);
      return new Response(JSON.stringify({ data: created }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    });

    expect(result.tasksCreated).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body));

    expect(url).toBe("http://localhost:3002/api/work");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer initiative-token",
      "content-type": "application/json",
    });
    expect(requestBody).toMatchObject({
      hiveId,
      goalId: staleGoalId,
      createdBy: "initiative-engine",
    });
    expect(requestBody).not.toHaveProperty("assignedTo");
  });

  it("normalizes surrounding whitespace on INTERNAL_SERVICE_TOKEN before calling /api/work", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "  initiative-token  ";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Parameters<typeof submitWorkDirect>[0];
      const created = await submitWorkDirect(body);
      return new Response(JSON.stringify({ data: created }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    });

    expect(result.tasksCreated).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer initiative-token",
    });
  });
});
