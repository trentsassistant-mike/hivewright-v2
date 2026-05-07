import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInitiativeEvaluation } from "@/initiative-engine";
import {
  createDormantGoalProofFixture,
  DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID,
  inspectDormantGoalProofPreflight,
} from "@/initiative-engine/proof-fixture";
import { testSql as sql, truncateAll } from "../_lib/test-db";

function submitWorkDirect(input: {
  hiveId: string;
  input: string;
  projectId?: string | null;
  goalId?: string | null;
  priority: number;
  acceptanceCriteria: string;
}) {
  return sql<Array<{ id: string; title: string }>>`
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
      'Dormant goal proof task',
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
  `.then(([task]) => ({
    id: task.id,
    type: "task" as const,
    title: task.title,
    classification: { provider: "test-provider", model: "test-model", confidence: 0.9, reasoning: "task classification", usedFallback: false },
  }));
}

describe.sequential("dormant-goal proof fixture", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES
        ('dev-agent', 'Developer Agent', 'executor', 'claude-code'),
        ('initiative-engine', 'Initiative Engine', 'executor', 'claude-code'),
        ('goal-supervisor', 'Goal Supervisor', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("preflights cleanly and deterministically produces create-one suppress-one", async () => {
    const fixture = await createDormantGoalProofFixture(sql);
    const preflight = await inspectDormantGoalProofPreflight(sql, fixture);

    expect(preflight.ready).toBe(true);
    expect(preflight.failures).toEqual([]);
    expect(preflight.primaryGoal.goalId).toBe(fixture.primaryGoalId);
    expect(preflight.suppressionControlGoal.goalId).toBe(fixture.suppressionControlGoalId);
    expect(preflight.suppressionControlGoal.goalId).not.toBe(DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID);

    const result = await runInitiativeEvaluation(sql, {
      hiveId: fixture.hiveId,
      trigger: { kind: "schedule", scheduleId: fixture.scheduleId },
    }, {
      submitWork: submitWorkDirect,
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.suppressed).toBe(1);

    const primaryOutcome = result.outcomes.find((outcome) => outcome.goalId === fixture.primaryGoalId);
    const suppressionOutcome = result.outcomes.find(
      (outcome) => outcome.goalId === fixture.suppressionControlGoalId,
    );

    expect(primaryOutcome?.actionTaken).toBe("create_task");
    expect(suppressionOutcome?.actionTaken).toBe("suppress");
    expect(suppressionOutcome?.suppressionReason).toBe("per_run_cap");
  });

  it("fails preflight when the primary fixture goal already has open work", async () => {
    const fixture = await createDormantGoalProofFixture(sql);

    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        priority,
        title,
        brief,
        goal_id,
        acceptance_criteria
      )
      VALUES (
        ${fixture.hiveId},
        'dev-agent',
        'system',
        'active',
        3,
        'Existing goal task',
        'Blocks dormant-goal proof fixture eligibility.',
        ${fixture.primaryGoalId},
        'Do not run dormant-goal proof while this task is open.'
      )
    `;

    const preflight = await inspectDormantGoalProofPreflight(sql, fixture);

    expect(preflight.ready).toBe(false);
    expect(preflight.failures).toContain(
      `primary fixture goal ${fixture.primaryGoalId} must have zero open tasks`,
    );
  });

  it("fails preflight when cooldown state already exists for the primary fixture goal", async () => {
    const fixture = await createDormantGoalProofFixture(sql);

    const [run] = await sql<Array<{ id: string }>>`
      INSERT INTO initiative_runs (
        hive_id,
        trigger_type,
        trigger_ref,
        status,
        started_at,
        completed_at,
        evaluated_candidates,
        created_count,
        created_tasks
      )
      VALUES (
        ${fixture.hiveId},
        'schedule',
        ${fixture.scheduleId},
        'completed',
        NOW() - interval '2 hours',
        NOW() - interval '2 hours',
        1,
        1,
        1
      )
      RETURNING id
    `;

    await sql`
      INSERT INTO initiative_run_decisions (
        run_id,
        hive_id,
        trigger_type,
        candidate_key,
        candidate_ref,
        action_taken,
        rationale,
        dedupe_key,
        created_at
      )
      VALUES (
        ${run.id},
        ${fixture.hiveId},
        'schedule',
        ${`dormant-goal-next-task:${fixture.primaryGoalId}`},
        ${fixture.primaryGoalId},
        'create_task',
        'Prior proof run created a task.',
        ${`dormant-goal-next-task:${fixture.primaryGoalId}`},
        NOW() - interval '2 hours'
      )
    `;

    const preflight = await inspectDormantGoalProofPreflight(sql, fixture);

    expect(preflight.ready).toBe(false);
    expect(preflight.failures).toContain(
      `primary fixture goal ${fixture.primaryGoalId} is still inside the 24h cooldown window`,
    );
  });
});
