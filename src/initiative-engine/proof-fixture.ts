import type { Sql } from "postgres";
import {
  countCreatedInitiativeActionsSince,
  countCreatedInitiativeActionsToday,
  findRecentCreatedDecisionByDedupeKey,
} from "./store";
import {
  DORMANT_GOAL_MIN_AGE_HOURS,
  INITIATIVE_COOLDOWN_HOURS,
  MAX_CREATED_TASKS_PER_DAY,
  MAX_CREATED_TASKS_PER_HOUR,
  MAX_OPEN_TASKS_BEFORE_SUPPRESS,
} from "./constants";

export const DORMANT_GOAL_WORKSTREAM_GOAL_ID = "8dc643d6-344a-4193-9502-e0961e6ab40b";
export const DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID = "a2030e88-4aea-430b-ba8f-80992b2e2974";
export const DORMANT_GOAL_PROOF_HIVE_SLUG = "dormant-goal-proof-fixture";
export const DORMANT_GOAL_PROOF_HIVE_NAME = "Dormant Goal Proof Fixture";
export const DORMANT_GOAL_PROOF_PRIMARY_TITLE = "Revive dormant goal";
export const DORMANT_GOAL_PROOF_CONTROL_TITLE =
  "Dormant goal suppression control (fixture only)";

export interface DormantGoalProofFixture {
  hiveId: string;
  scheduleId: string;
  primaryGoalId: string;
  suppressionControlGoalId: string;
  workstreamGoalId: string;
  excludedLiveGoalId: string;
}

export interface DormantGoalProofPreflightGoal {
  goalId: string;
  title: string;
  status: string;
  lastGoalProgressAt: string;
  hoursSinceGoalProgress: number;
  openTaskCount: number;
  cooldownActive: boolean;
}

export interface DormantGoalProofPreflight {
  ready: boolean;
  failures: string[];
  hiveId: string;
  scheduleId: string;
  workstreamGoalId: string;
  excludedLiveGoalId: string;
  schedule: {
    enabled: boolean;
    dueNow: boolean;
    matchingEnabledScheduleCount: number;
  };
  hive: {
    openTasks: number;
    createdToday: number;
    createdThisHour: number;
  };
  primaryGoal: DormantGoalProofPreflightGoal;
  suppressionControlGoal: DormantGoalProofPreflightGoal;
}

interface FixtureGoalRow {
  goalId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastGoalProgressAt: Date;
  hoursSinceGoalProgress: number | string;
  openTaskCount: number;
}

async function loadFixtureGoal(sql: Sql, goalId: string): Promise<FixtureGoalRow> {
  const [row] = await sql<FixtureGoalRow[]>`
    SELECT
      g.id AS "goalId",
      g.title,
      g.status,
      g.created_at AS "createdAt",
      g.updated_at AS "updatedAt",
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
      )) / 3600 AS "hoursSinceGoalProgress",
      (
        SELECT COUNT(*)::int
        FROM tasks t
        WHERE t.goal_id = g.id
          AND t.status IN ('pending', 'active', 'blocked', 'in_review')
      ) AS "openTaskCount"
    FROM goals g
    WHERE g.id = ${goalId}
    LIMIT 1
  `;

  if (!row) {
    throw new Error(`[dormant-goal-proof-fixture] goal ${goalId} not found`);
  }

  return row;
}

function toPreflightGoal(
  row: FixtureGoalRow,
  cooldownActive: boolean,
): DormantGoalProofPreflightGoal {
  return {
    goalId: row.goalId,
    title: row.title,
    status: row.status,
    lastGoalProgressAt: row.lastGoalProgressAt.toISOString(),
    hoursSinceGoalProgress: Number(Number(row.hoursSinceGoalProgress).toFixed(2)),
    openTaskCount: row.openTaskCount,
    cooldownActive,
  };
}

export async function createDormantGoalProofFixture(sql: Sql): Promise<DormantGoalProofFixture> {
  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type, description)
    VALUES (
      ${DORMANT_GOAL_PROOF_HIVE_SLUG},
      ${DORMANT_GOAL_PROOF_HIVE_NAME},
      'digital',
      ${`Fixture for dormant-goal proof on workstream ${DORMANT_GOAL_WORKSTREAM_GOAL_ID}; distinct from live achieved goal ${DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID}.`}
    )
    RETURNING id
  `;

  const [primaryGoal] = await sql<Array<{ id: string }>>`
    INSERT INTO goals (hive_id, title, description, status, created_at, updated_at)
    VALUES (
      ${hive.id},
      ${DORMANT_GOAL_PROOF_PRIMARY_TITLE},
      'Make forward progress on the dormant work.',
      'active',
      NOW() - interval '5 days',
      NOW() - interval '4 days'
    )
    RETURNING id
  `;

  const [suppressionControlGoal] = await sql<Array<{ id: string }>>`
    INSERT INTO goals (hive_id, title, description, status, created_at, updated_at)
    VALUES (
      ${hive.id},
      ${DORMANT_GOAL_PROOF_CONTROL_TITLE},
      ${`Fixture control candidate for per-run-cap suppression. This is not live goal ${DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID}.`},
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
      'script:setup-dormant-goal-proof-fixture'
    )
    RETURNING id
  `;

  return {
    hiveId: hive.id,
    scheduleId: schedule.id,
    primaryGoalId: primaryGoal.id,
    suppressionControlGoalId: suppressionControlGoal.id,
    workstreamGoalId: DORMANT_GOAL_WORKSTREAM_GOAL_ID,
    excludedLiveGoalId: DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID,
  };
}

export async function inspectDormantGoalProofPreflight(
  sql: Sql,
  fixture: DormantGoalProofFixture,
): Promise<DormantGoalProofPreflight> {
  const failures: string[] = [];

  const [schedule] = await sql<Array<{
    enabled: boolean;
    dueNow: boolean;
    matchingEnabledScheduleCount: number;
  }>>`
    SELECT
      s.enabled,
      (s.next_run_at <= NOW()) AS "dueNow",
      (
        SELECT COUNT(*)::int
        FROM schedules s2
        WHERE s2.hive_id = ${fixture.hiveId}
          AND s2.enabled = true
          AND s2.task_template ->> 'kind' = 'initiative-evaluation'
      ) AS "matchingEnabledScheduleCount"
    FROM schedules s
    WHERE s.id = ${fixture.scheduleId}
    LIMIT 1
  `;

  if (!schedule) {
    failures.push(`fixture schedule ${fixture.scheduleId} not found`);
  } else {
    if (!schedule.enabled) {
      failures.push(`fixture schedule ${fixture.scheduleId} must be enabled`);
    }
    if (!schedule.dueNow) {
      failures.push(`fixture schedule ${fixture.scheduleId} must be due now`);
    }
    if (schedule.matchingEnabledScheduleCount !== 1) {
      failures.push("fixture hive must have exactly one enabled initiative-evaluation schedule");
    }
  }

  const primaryGoal = await loadFixtureGoal(sql, fixture.primaryGoalId);
  const suppressionControlGoal = await loadFixtureGoal(sql, fixture.suppressionControlGoalId);

  const createdToday = await countCreatedInitiativeActionsToday(sql, fixture.hiveId);
  const createdThisHour = await countCreatedInitiativeActionsSince(sql, {
    hiveId: fixture.hiveId,
    hours: 1,
  });

  const [hiveQueue] = await sql<Array<{ openTasks: number }>>`
    SELECT COUNT(*)::int AS "openTasks"
    FROM tasks
    WHERE hive_id = ${fixture.hiveId}
      AND status IN ('pending', 'active', 'blocked', 'in_review')
  `;

  const primaryCooldown = await findRecentCreatedDecisionByDedupeKey(sql, {
    hiveId: fixture.hiveId,
    dedupeKey: `dormant-goal-next-task:${fixture.primaryGoalId}`,
    cooldownHours: INITIATIVE_COOLDOWN_HOURS,
  });
  const suppressionControlCooldown = await findRecentCreatedDecisionByDedupeKey(sql, {
    hiveId: fixture.hiveId,
    dedupeKey: `dormant-goal-next-task:${fixture.suppressionControlGoalId}`,
    cooldownHours: INITIATIVE_COOLDOWN_HOURS,
  });

  if (fixture.suppressionControlGoalId === DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID) {
    failures.push(`fixture suppression-control goal must stay distinct from live achieved goal ${DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID}`);
  }

  if (primaryGoal.status !== "active") {
    failures.push(`primary fixture goal ${fixture.primaryGoalId} must be active`);
  }
  if (suppressionControlGoal.status !== "active") {
    failures.push(`suppression-control fixture goal ${fixture.suppressionControlGoalId} must be active`);
  }
  if (Number(primaryGoal.hoursSinceGoalProgress) < DORMANT_GOAL_MIN_AGE_HOURS) {
    failures.push(`primary fixture goal ${fixture.primaryGoalId} must be dormant for at least ${DORMANT_GOAL_MIN_AGE_HOURS} hours`);
  }
  if (Number(suppressionControlGoal.hoursSinceGoalProgress) < DORMANT_GOAL_MIN_AGE_HOURS) {
    failures.push(`suppression-control fixture goal ${fixture.suppressionControlGoalId} must be dormant for at least ${DORMANT_GOAL_MIN_AGE_HOURS} hours`);
  }
  if (primaryGoal.openTaskCount !== 0) {
    failures.push(`primary fixture goal ${fixture.primaryGoalId} must have zero open tasks`);
  }
  if (suppressionControlGoal.openTaskCount !== 0) {
    failures.push(`suppression-control fixture goal ${fixture.suppressionControlGoalId} must have zero open tasks`);
  }
  if (primaryCooldown) {
    failures.push(`primary fixture goal ${fixture.primaryGoalId} is still inside the ${INITIATIVE_COOLDOWN_HOURS}h cooldown window`);
  }
  if (suppressionControlCooldown) {
    failures.push(`suppression-control fixture goal ${fixture.suppressionControlGoalId} is still inside the ${INITIATIVE_COOLDOWN_HOURS}h cooldown window`);
  }
  if (primaryGoal.lastGoalProgressAt >= suppressionControlGoal.lastGoalProgressAt) {
    failures.push("primary fixture goal must be the stalest candidate so create-one happens before suppress-one");
  }
  if ((hiveQueue?.openTasks ?? 0) >= MAX_OPEN_TASKS_BEFORE_SUPPRESS) {
    failures.push(`fixture hive open tasks must stay below ${MAX_OPEN_TASKS_BEFORE_SUPPRESS}`);
  }
  if (createdToday >= MAX_CREATED_TASKS_PER_DAY) {
    failures.push(`fixture hive already reached the per-day creation cap of ${MAX_CREATED_TASKS_PER_DAY}`);
  }
  if (createdThisHour >= MAX_CREATED_TASKS_PER_HOUR) {
    failures.push(`fixture hive already reached the hourly creation cap of ${MAX_CREATED_TASKS_PER_HOUR}`);
  }

  return {
    ready: failures.length === 0,
    failures,
    hiveId: fixture.hiveId,
    scheduleId: fixture.scheduleId,
    workstreamGoalId: fixture.workstreamGoalId,
    excludedLiveGoalId: fixture.excludedLiveGoalId,
    schedule: {
      enabled: schedule?.enabled ?? false,
      dueNow: schedule?.dueNow ?? false,
      matchingEnabledScheduleCount: schedule?.matchingEnabledScheduleCount ?? 0,
    },
    hive: {
      openTasks: hiveQueue?.openTasks ?? 0,
      createdToday,
      createdThisHour,
    },
    primaryGoal: toPreflightGoal(primaryGoal, Boolean(primaryCooldown)),
    suppressionControlGoal: toPreflightGoal(
      suppressionControlGoal,
      Boolean(suppressionControlCooldown),
    ),
  };
}
