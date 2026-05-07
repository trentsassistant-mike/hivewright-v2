import "dotenv/config";
import postgres from "postgres";
import { requireEnv } from "../src/lib/required-env";

const DATABASE_URL = requireEnv("DATABASE_URL");
const TARGET_GOAL_ID = "14c723f1-e235-467b-9f9f-7f5f0f0d1c9b";
const TARGET_SCHEDULE_ID = "e478adf9-ae66-440b-b58a-5367cbf3c7d7";
const DORMANT_MIN_AGE_HOURS = 24;

interface ScheduleRow {
  id: string;
  hive_id: string;
  enabled: boolean;
  cron_expression: string;
  next_run_at: Date;
  task_template: Record<string, unknown>;
}

interface GoalRow {
  id: string;
  hive_id: string;
  title: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  session_id: string | null;
}

interface GoalActivityRow {
  lastGoalProgressAt: Date;
  hoursSinceGoalProgress: number | string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  created_by: string | null;
  assigned_to: string | null;
  created_at: Date;
}

interface DecisionRow {
  id: string;
  run_id: string;
  action_taken: string;
  suppression_reason: string | null;
  created_task_id: string | null;
  created_at: Date;
}

async function main() {
  const sql = postgres(DATABASE_URL);

  try {
    const [schedule] = await sql<ScheduleRow[]>`
      SELECT id, hive_id, enabled, cron_expression, next_run_at, task_template
      FROM schedules
      WHERE id = ${TARGET_SCHEDULE_ID}
      LIMIT 1
    `;

    const [goal] = await sql<GoalRow[]>`
      SELECT id, hive_id, title, status, created_at, updated_at, session_id
      FROM goals
      WHERE id = ${TARGET_GOAL_ID}
      LIMIT 1
    `;

    const [activity] = await sql<GoalActivityRow[]>`
      SELECT
        GREATEST(
          g.updated_at,
          COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
          COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
        ) AS "lastGoalProgressAt",
        EXTRACT(EPOCH FROM (
          NOW() - GREATEST(
            g.updated_at,
            COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
            COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
          )
        )) / 3600 AS "hoursSinceGoalProgress"
      FROM goals g
      WHERE g.id = ${TARGET_GOAL_ID}
      LIMIT 1
    `;

    const openTasks = await sql<TaskRow[]>`
      SELECT id, title, status, created_by, assigned_to, created_at
      FROM tasks
      WHERE goal_id = ${TARGET_GOAL_ID}
        AND status IN ('pending', 'active', 'blocked', 'in_review')
      ORDER BY created_at ASC
    `;

    const [latestDecision] = await sql<DecisionRow[]>`
      SELECT id, run_id, action_taken, suppression_reason, created_task_id, created_at
      FROM initiative_run_decisions
      WHERE candidate_ref = ${TARGET_GOAL_ID}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!schedule) {
      throw new Error(`missing schedule ${TARGET_SCHEDULE_ID}`);
    }

    if (!goal) {
      throw new Error(`missing goal ${TARGET_GOAL_ID}`);
    }

    const scheduleGoalId =
      typeof schedule.task_template?.goalId === "string" ? schedule.task_template.goalId : null;
    const goalIdleHours = Number(activity?.hoursSinceGoalProgress ?? 0);
    const dormantEligible =
      goal.status === "active" &&
      goalIdleHours >= DORMANT_MIN_AGE_HOURS &&
      !(goal.session_id === null && goal.created_at > new Date(Date.now() - 60 * 60 * 1000));

    const blockers: string[] = [];
    if (scheduleGoalId !== TARGET_GOAL_ID) {
      blockers.push("schedule_not_scoped_to_target_goal");
    }
    if (openTasks.length > 0) {
      blockers.push("open_goal_task_exists");
    }
    if (!dormantEligible) {
      blockers.push("goal_not_dormant_eligible");
    }

    const command = [
      "psql \"$DATABASE_URL\" -c",
      `"UPDATE schedules SET task_template = jsonb_set(task_template, '{goalId}', to_jsonb('${TARGET_GOAL_ID}'::text), true), next_run_at = NOW() - interval '1 minute' WHERE id = '${TARGET_SCHEDULE_ID}';"`,
    ].join(" ");

    const report = {
      checkedAt: new Date().toISOString(),
      databaseUrl: DATABASE_URL,
      target: {
        goalId: TARGET_GOAL_ID,
        scheduleId: TARGET_SCHEDULE_ID,
      },
      canonicalPath: {
        scheduler: "src/dispatcher/schedule-timer.ts",
        initiativeRuntime: "src/initiative-engine/index.ts",
        trigger: "schedules.task_template.kind = 'initiative-evaluation'",
        expectedTransition:
          "schedule due -> checkAndFireSchedules() -> runInitiativeEvaluation(trigger.targetGoalId) -> create task via /api/work for target goal",
      },
      readiness: blockers.length === 0 ? "ready" : "blocked",
      blockers,
      schedule: {
        hiveId: schedule.hive_id,
        enabled: schedule.enabled,
        cronExpression: schedule.cron_expression,
        nextRunAt: schedule.next_run_at.toISOString(),
        scopedGoalId: scheduleGoalId,
        taskTemplate: schedule.task_template,
      },
      goal: {
        hiveId: goal.hive_id,
        title: goal.title,
        status: goal.status,
        updatedAt: goal.updated_at.toISOString(),
        lastGoalProgressAt: activity?.lastGoalProgressAt.toISOString() ?? null,
        hoursSinceGoalProgress: Number(goalIdleHours.toFixed(2)),
        dormantEligible,
      },
      openTasks: openTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        createdBy: task.created_by,
        assignedTo: task.assigned_to,
        createdAt: task.created_at.toISOString(),
      })),
      latestDecision: latestDecision
        ? {
          id: latestDecision.id,
          runId: latestDecision.run_id,
          actionTaken: latestDecision.action_taken,
          suppressionReason: latestDecision.suppression_reason,
          createdTaskId: latestDecision.created_task_id,
          createdAt: latestDecision.created_at.toISOString(),
        }
        : null,
      operatorFollowUp: {
        scopeAndFireSql: command,
        expectedIfReady:
          "The next scheduler tick evaluates only the target goal and creates one initiative-engine task if no open goal task exists and goal-level progress is older than 24 hours.",
        expectedIfBlocked:
          "The run records the targeted schedule trigger but suppresses or skips creation because the existing open-task or dormancy guardrail still applies.",
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(
    "[initiative:live-proof:readiness] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
