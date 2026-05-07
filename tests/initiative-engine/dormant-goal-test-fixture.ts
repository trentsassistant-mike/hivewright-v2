import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

export const PRIMARY_DORMANT_GOAL_TITLE = "Revive dormant goal";
export const SECONDARY_DORMANT_GOAL_TITLE = "Second dormant goal";

export interface DormantGoalTestFixture {
  hiveId: string;
  primaryGoalId: string;
  secondaryGoalId: string;
  scheduleId: string;
}

export async function seedDormantGoalTestFixture(
  sql: Sql,
  input: {
    hiveSlugPrefix: string;
    hiveName: string;
  },
): Promise<DormantGoalTestFixture> {
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const hiveSlug = `${input.hiveSlugPrefix}-${randomUUID().slice(0, 8)}`;
  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES (${hiveSlug}, ${input.hiveName}, 'digital')
    RETURNING id
  `;

  const [primaryGoal] = await sql<Array<{ id: string }>>`
    INSERT INTO goals (hive_id, title, description, status, created_at, updated_at)
    VALUES (
      ${hive.id},
      ${PRIMARY_DORMANT_GOAL_TITLE},
      'Make forward progress on the dormant work.',
      'active',
      NOW() - interval '5 days',
      NOW() - interval '4 days'
    )
    RETURNING id
  `;

  const [secondaryGoal] = await sql<Array<{ id: string }>>`
    INSERT INTO goals (hive_id, title, description, status, created_at, updated_at)
    VALUES (
      ${hive.id},
      ${SECONDARY_DORMANT_GOAL_TITLE},
      'Another goal that should be suppressed by the per-run cap.',
      'active',
      NOW() - interval '4 days',
      NOW() - interval '3 days'
    )
    RETURNING id
  `;

  const [schedule] = await sql<Array<{ id: string }>>`
    INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
    VALUES (
      ${hive.id},
      '0 * * * *',
      ${sql.json({
        kind: "initiative-evaluation",
        assignedTo: "initiative-engine",
        title: "Initiative evaluation",
        brief: "(populated at run time)",
      })},
      true,
      NOW() - interval '1 minute',
      'test'
    )
    RETURNING id
  `;

  return {
    hiveId: hive.id,
    primaryGoalId: primaryGoal.id,
    secondaryGoalId: secondaryGoal.id,
    scheduleId: schedule.id,
  };
}
