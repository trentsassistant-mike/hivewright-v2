import { closeTestSql, testSql as sql } from "../tests/_lib/test-db";
import { checkAndFireSchedules } from "../src/dispatcher/schedule-timer";
import { runIdeasDailyReview } from "../src/ideas/daily-review";
import { withDisposableHive } from "./_lib/disposable-hive";

async function proveScheduleDispatch() {
  return withDisposableHive(sql, "Ideas Proof Dispatch", async (hiveId) => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hiveId},
        '0 9 * * *',
        ${sql.json({
          kind: "ideas-daily-review",
          assignedTo: "ideas-curator",
          title: "Ideas daily review",
          brief: "(populated at run time)",
        })},
        true,
        NOW() - interval '1 minute',
        'proof'
      )
    `;

    const fired = await checkAndFireSchedules(sql);
    const [schedule] = await sql<{ last_run_at: Date | null; next_run_at: Date | null }[]>`
      SELECT last_run_at, next_run_at
      FROM schedules
      WHERE hive_id = ${hiveId}
    `;
    const [{ count }] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM tasks
      WHERE hive_id = ${hiveId}
    `;

    return {
      fired,
      lastRunAt: schedule.last_run_at?.toISOString() ?? null,
      nextRunAt: schedule.next_run_at?.toISOString() ?? null,
      placeholderTasks: Number(count),
    };
  });
}

async function proveReviewRunner() {
  return withDisposableHive(sql, "Ideas Proof Review", async (hiveId) => {
    await sql`
      UPDATE hives
      SET mission = 'Promote strong ideas.'
      WHERE id = ${hiveId}
    `;
    await sql`
      INSERT INTO hive_targets (hive_id, title, target_value, status)
      VALUES (${hiveId}, 'Ship one promoted idea', '1', 'open')
    `;
    const [idea] = await sql<{ id: string }[]>`
      INSERT INTO hive_ideas (hive_id, title, body, created_by, status)
      VALUES (${hiveId}, 'Daily digest', 'Create a daily digest from ideas.', 'owner', 'open')
      RETURNING id
    `;

    const result = await runIdeasDailyReview(sql, hiveId, {
      buildContext: async () => "context",
      invokeCurator: async () => ({
        picked_idea_id: idea.id,
        fit_rationale: "High fit with current mission and target.",
        recommended_action: "promote",
        goal_brief: "Create a daily digest goal from the ideas backlog.",
      }),
      submitWork: async ({ goalBrief }) => {
        const [goal] = await sql<{ id: string }[]>`
          INSERT INTO goals (hive_id, title, description)
          VALUES (${hiveId}, 'Daily digest', ${goalBrief})
          RETURNING id
        `;
        return { id: goal.id, type: "goal" as const };
      },
    });

    const [ideaAfter] = await sql<{
      status: string;
      promoted_to_goal_id: string | null;
      ai_assessment: string | null;
    }[]>`
      SELECT status, promoted_to_goal_id, ai_assessment
      FROM hive_ideas
      WHERE id = ${idea.id}
    `;

    return { result, ideaAfter };
  });
}

async function main() {
  const dispatchProof = await proveScheduleDispatch();
  const reviewProof = await proveReviewRunner();
  console.log(
    JSON.stringify(
      {
        dispatchProof,
        reviewProof,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeTestSql();
  });
