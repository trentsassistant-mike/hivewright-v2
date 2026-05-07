import { beforeEach, describe, expect, it } from "vitest";
import { runInitiativeEvaluation } from "@/initiative-engine";
import { seedDormantGoalTestFixture } from "./dormant-goal-test-fixture";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let firstGoalId: string;
let secondGoalId: string;
let scheduleId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const fixture = await seedDormantGoalTestFixture(sql, {
    hiveSlugPrefix: "follow-up-guardrail-hive",
    hiveName: "Follow-up Guardrail Hive",
  });
  hiveId = fixture.hiveId;
  firstGoalId = fixture.primaryGoalId;
  secondGoalId = fixture.secondaryGoalId;
  scheduleId = fixture.scheduleId;
});

describe.sequential("initiative follow-up guardrails", () => {
  it("still creates at most one dormant-goal follow-up per run and suppresses the next candidate", async () => {
    let createdCount = 0;
    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, {
      submitWork: async (input) => {
        createdCount += 1;
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
            qa_required
          )
          VALUES (
            ${input.hiveId},
            ${input.goalId ?? null},
            ${`Initiative follow-up ${createdCount}`},
            ${input.input},
            'pending',
            'dev-agent',
            'initiative-engine',
            ${input.acceptanceCriteria},
            ${input.priority},
            false
          )
          RETURNING id, title
        `;

        return {
          id: task.id,
          type: "task",
          title: task.title,
          classification: { source: "test-submit-work" },
        };
      },
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.suppressed).toBe(1);

    const createdOutcome = result.outcomes.find((outcome) => outcome.actionTaken === "create_task");
    const suppressedOutcome = result.outcomes.find((outcome) => outcome.goalId === secondGoalId);

    expect(createdOutcome?.goalId).toBe(firstGoalId);
    expect(suppressedOutcome).toMatchObject({
      actionTaken: "suppress",
      suppressionReason: "per_run_cap",
    });

    const [createdTaskCount] = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE hive_id = ${hiveId}
        AND created_by = 'initiative-engine'
    `;
    expect(createdTaskCount.count).toBe(1);

    const [secondGoalTaskCount] = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE hive_id = ${hiveId}
        AND goal_id = ${secondGoalId}
        AND created_by = 'initiative-engine'
    `;
    expect(secondGoalTaskCount.count).toBe(0);

    const decisions = await sql<Array<{
      candidate_ref: string | null;
      action_taken: string;
      suppression_reason: string | null;
    }>>`
      SELECT candidate_ref, action_taken, suppression_reason
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
      ORDER BY created_at ASC
    `;

    expect(decisions).toEqual([
      {
        candidate_ref: firstGoalId,
        action_taken: "create_task",
        suppression_reason: null,
      },
      {
        candidate_ref: secondGoalId,
        action_taken: "suppress",
        suppression_reason: "per_run_cap",
      },
    ]);
  });
});
