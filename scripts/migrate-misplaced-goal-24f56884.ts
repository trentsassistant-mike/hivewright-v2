import "dotenv/config";

import { execFileSync } from "node:child_process";
import type { Sql, TransactionSql } from "postgres";
import postgres from "postgres";

const GOAL_ID = "24f56884-55a1-4871-9c15-ab6c362d82fe";
const SOURCE_HIVE_ID = "fdb79a51-f605-4925-9ca2-0b52340191af";
const DESTINATION_HIVE_ID = "b6b815ba-5109-4066-8a33-cc5560d3a0e1";
const SCHEDULE_ID = "f4f8d4b4-f63b-4d3e-9729-13ccf8d90edc";
const EXTERNAL_WORLD_SCAN_WORK_PRODUCT_ID = "39e28301-d3b6-479e-811f-bef52ea355b1";
const CONFIRM_ENV = "CONFIRM_MIGRATE_GOAL_24F56884";

const EXPECTED_BEFORE = {
  goals: 1,
  tasks: 4,
  work_products: 4,
  task_logs: 41,
  goal_documents: 1,
  goal_completions: 1,
  hive_memory: 4,
  role_memory: 15,
  memory_embeddings: 17,
  entities: 43,
  insights: 3,
  schedules: 1,
  task_attachments: 0,
  goal_comments: 0,
  decisions: 0,
  decision_messages: 0,
  classifications: 0,
  task_quality_signals: 0,
  supervisor_reports: 0,
  initiative_run_decisions: 0,
  hive_ideas: 0,
  skill_drafts: 0,
} as const;

const EXPECTED_MOVE_COUNTS = {
  goals: 1,
  tasks: 4,
  work_products: 4,
  hive_memory: 4,
  role_memory: 15,
  memory_embeddings: 17,
  entities: 43,
  insights: 3,
  schedules: 1,
} as const;

type Artifact = keyof typeof EXPECTED_BEFORE;
type MoveArtifact = keyof typeof EXPECTED_MOVE_COUNTS;

type CountRow = {
  artifact: Artifact;
  hive_id: string | null;
  count: number | string;
};

type CountByHive = Partial<Record<Artifact, Record<string, number>>>;
type QuerySql = Sql | TransactionSql;

type ScalarCountRow = {
  artifact: Artifact;
  count: number | string;
};

type UpdateRow = {
  artifact: MoveArtifact;
  count: number | string;
};

type GoalRow = {
  id: string;
  hive_id: string;
  title: string;
  status: string;
};

type HiveRow = {
  id: string;
  name: string;
  slug: string | null;
};

type ScheduleRow = {
  id: string;
  hive_id: string;
  cron_expression: string;
  enabled: boolean;
  next_run_at: string | Date | null;
  created_by: string;
  task_kind: string | null;
  assigned_to: string | null;
};

type InsightRow = {
  id: string;
  hive_id: string;
  source_work_products: string[];
  has_external_world_scan_wp: boolean;
};

function getGitValue(args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

function toInt(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function addCount(rows: CountRow[]): CountByHive {
  const out: CountByHive = {};
  for (const row of rows) {
    const artifact = row.artifact;
    const hiveId = row.hive_id ?? "null";
    out[artifact] ??= {};
    out[artifact][hiveId] = toInt(row.count);
  }
  return out;
}

function sourceCount(counts: CountByHive, artifact: Artifact): number {
  return counts[artifact]?.[SOURCE_HIVE_ID] ?? 0;
}

function destinationCount(counts: CountByHive, artifact: Artifact): number {
  return counts[artifact]?.[DESTINATION_HIVE_ID] ?? 0;
}

function assertExpectedBefore(counts: CountByHive, scalarCounts: Partial<Record<Artifact, number>>) {
  const mismatches: string[] = [];
  for (const [artifact, expected] of Object.entries(EXPECTED_BEFORE) as [Artifact, number][]) {
    const actual =
      artifact in scalarCounts ? (scalarCounts[artifact] ?? 0) : sourceCount(counts, artifact);
    if (actual !== expected) {
      mismatches.push(`${artifact}: expected ${expected}, got ${actual}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `[migrate-goal-24f56884] pre-migration inventory drift:\n${mismatches.join("\n")}`,
    );
  }
}

function assertMoveCounts(rows: UpdateRow[]) {
  const mismatches: string[] = [];
  const byArtifact = new Map(rows.map((row) => [row.artifact, toInt(row.count)]));
  for (const [artifact, expected] of Object.entries(EXPECTED_MOVE_COUNTS) as [
    MoveArtifact,
    number,
  ][]) {
    const actual = byArtifact.get(artifact) ?? 0;
    if (actual !== expected) {
      mismatches.push(`${artifact}: expected ${expected}, updated ${actual}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `[migrate-goal-24f56884] update count mismatch; transaction will roll back:\n${mismatches.join("\n")}`,
    );
  }
}

function assertAfter(counts: CountByHive) {
  const mismatches: string[] = [];
  for (const [artifact, expected] of Object.entries(EXPECTED_MOVE_COUNTS) as [
    MoveArtifact,
    number,
  ][]) {
    const source = sourceCount(counts, artifact);
    const destination = destinationCount(counts, artifact);
    if (source !== 0 || destination !== expected) {
      mismatches.push(`${artifact}: expected source=0 destination=${expected}, got source=${source} destination=${destination}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `[migrate-goal-24f56884] post-migration verification failed; transaction will roll back:\n${mismatches.join("\n")}`,
    );
  }
}

async function queryHiveCounts(sql: QuerySql): Promise<CountByHive> {
  const rows = await sql<CountRow[]>`
    WITH RECURSIVE task_tree AS (
      SELECT t.id FROM tasks t WHERE t.goal_id = ${GOAL_ID}::uuid
      UNION
      SELECT child.id FROM tasks child JOIN task_tree tt ON child.parent_task_id = tt.id
    ),
    wp_set AS (
      SELECT id FROM work_products WHERE task_id IN (SELECT id FROM task_tree)
    ),
    insight_set AS (
      SELECT i.id
      FROM insights i
      WHERE EXISTS (
        SELECT 1 FROM wp_set w
        WHERE i.source_work_products ? w.id::text
      )
    )
    SELECT 'goals' AS artifact, hive_id, count(*)::int FROM goals
    WHERE id = ${GOAL_ID}::uuid GROUP BY hive_id
    UNION ALL
    SELECT 'tasks', hive_id, count(*)::int FROM tasks WHERE id IN (SELECT id FROM task_tree) GROUP BY hive_id
    UNION ALL
    SELECT 'work_products', hive_id, count(*)::int FROM work_products WHERE id IN (SELECT id FROM wp_set) GROUP BY hive_id
    UNION ALL
    SELECT 'hive_memory', hive_id, count(*)::int FROM hive_memory WHERE source_task_id IN (SELECT id FROM task_tree) GROUP BY hive_id
    UNION ALL
    SELECT 'role_memory', hive_id, count(*)::int FROM role_memory WHERE source_task_id IN (SELECT id FROM task_tree) GROUP BY hive_id
    UNION ALL
    SELECT 'memory_embeddings', hive_id, count(*)::int FROM memory_embeddings
    WHERE source_type = 'work_product' AND source_id IN (SELECT id FROM wp_set) GROUP BY hive_id
    UNION ALL
    SELECT 'entities', hive_id, count(*)::int FROM entities
    WHERE EXISTS (SELECT 1 FROM task_tree tt WHERE entities.source_task_ids ? tt.id::text) GROUP BY hive_id
    UNION ALL
    SELECT 'insights', hive_id, count(*)::int FROM insights WHERE id IN (SELECT id FROM insight_set) GROUP BY hive_id
    UNION ALL
    SELECT 'schedules', hive_id, count(*)::int FROM schedules WHERE id = ${SCHEDULE_ID}::uuid GROUP BY hive_id
  `;
  return addCount(rows);
}

async function queryScalarCounts(sql: QuerySql): Promise<Partial<Record<Artifact, number>>> {
  const rows = await sql<ScalarCountRow[]>`
    WITH RECURSIVE task_tree AS (
      SELECT t.id FROM tasks t WHERE t.goal_id = ${GOAL_ID}::uuid
      UNION
      SELECT child.id FROM tasks child JOIN task_tree tt ON child.parent_task_id = tt.id
    ),
    wp_set AS (
      SELECT id FROM work_products WHERE task_id IN (SELECT id FROM task_tree)
    ),
    goal_decision_set AS (
      SELECT id FROM decisions WHERE goal_id = ${GOAL_ID}::uuid
    )
    SELECT 'task_logs' AS artifact, count(*)::int FROM task_logs WHERE task_id IN (SELECT id FROM task_tree)
    UNION ALL SELECT 'goal_documents', count(*)::int FROM goal_documents WHERE goal_id = ${GOAL_ID}::uuid
    UNION ALL SELECT 'goal_completions', count(*)::int FROM goal_completions WHERE goal_id = ${GOAL_ID}::uuid
    UNION ALL SELECT 'task_attachments', count(*)::int FROM task_attachments WHERE task_id IN (SELECT id FROM task_tree)
    UNION ALL SELECT 'goal_comments', count(*)::int FROM goal_comments WHERE goal_id = ${GOAL_ID}::uuid
    UNION ALL SELECT 'decisions', count(*)::int FROM goal_decision_set
    UNION ALL SELECT 'decision_messages', count(*)::int FROM decision_messages WHERE decision_id IN (SELECT id FROM goal_decision_set)
    UNION ALL SELECT 'classifications', count(*)::int FROM classifications WHERE task_id IN (SELECT id FROM task_tree)
    UNION ALL SELECT 'task_quality_signals', count(*)::int FROM task_quality_signals WHERE task_id IN (SELECT id FROM task_tree)
    UNION ALL SELECT 'supervisor_reports', count(*)::int FROM supervisor_reports WHERE agent_task_id IN (SELECT id FROM task_tree)
    UNION ALL SELECT 'initiative_run_decisions', count(*)::int FROM initiative_run_decisions
      WHERE created_goal_id = ${GOAL_ID}::uuid
         OR created_task_id IN (SELECT id FROM task_tree)
         OR created_decision_id IN (SELECT id FROM goal_decision_set)
    UNION ALL SELECT 'hive_ideas', count(*)::int FROM hive_ideas WHERE promoted_to_goal_id = ${GOAL_ID}::uuid
    UNION ALL SELECT 'skill_drafts', count(*)::int FROM skill_drafts WHERE source_task_id IN (SELECT id FROM task_tree)
  `;
  return Object.fromEntries(rows.map((row) => [row.artifact, toInt(row.count)]));
}

async function queryGoal(sql: QuerySql): Promise<GoalRow | null> {
  const [goal] = await sql<GoalRow[]>`
    SELECT id, hive_id, title, status
    FROM goals
    WHERE id = ${GOAL_ID}::uuid
  `;
  return goal ?? null;
}

async function queryHives(sql: QuerySql): Promise<HiveRow[]> {
  return sql<HiveRow[]>`
    SELECT id, name, slug
    FROM hives
    WHERE id IN (${SOURCE_HIVE_ID}::uuid, ${DESTINATION_HIVE_ID}::uuid)
    ORDER BY id
  `;
}

async function querySchedule(sql: QuerySql): Promise<ScheduleRow | null> {
  const [schedule] = await sql<ScheduleRow[]>`
    SELECT
      id,
      hive_id,
      cron_expression,
      enabled,
      next_run_at,
      created_by,
      task_template ->> 'kind' AS task_kind,
      task_template ->> 'assignedTo' AS assigned_to
    FROM schedules
    WHERE id = ${SCHEDULE_ID}::uuid
  `;
  return schedule ?? null;
}

async function queryInsights(sql: QuerySql): Promise<InsightRow[]> {
  return sql<InsightRow[]>`
    WITH RECURSIVE task_tree AS (
      SELECT t.id FROM tasks t WHERE t.goal_id = ${GOAL_ID}::uuid
      UNION
      SELECT child.id FROM tasks child JOIN task_tree tt ON child.parent_task_id = tt.id
    ),
    wp_set AS (
      SELECT id FROM work_products WHERE task_id IN (SELECT id FROM task_tree)
    )
    SELECT
      i.id,
      i.hive_id,
      i.source_work_products,
      i.source_work_products ? ${EXTERNAL_WORLD_SCAN_WORK_PRODUCT_ID} AS has_external_world_scan_wp
    FROM insights i
    WHERE EXISTS (
      SELECT 1 FROM wp_set w
      WHERE i.source_work_products ? w.id::text
    )
    ORDER BY i.id
  `;
}

async function updateLineage(sql: postgres.TransactionSql): Promise<UpdateRow[]> {
  return sql<UpdateRow[]>`
    WITH RECURSIVE task_tree AS (
      SELECT t.id FROM tasks t WHERE t.goal_id = ${GOAL_ID}::uuid
      UNION
      SELECT child.id FROM tasks child JOIN task_tree tt ON child.parent_task_id = tt.id
    ),
    wp_set AS (
      SELECT id FROM work_products WHERE task_id IN (SELECT id FROM task_tree)
    ),
    insight_set AS (
      SELECT i.id
      FROM insights i
      WHERE EXISTS (
        SELECT 1 FROM wp_set w
        WHERE i.source_work_products ? w.id::text
      )
    ),
    entity_set AS (
      SELECT e.id
      FROM entities e
      WHERE EXISTS (
        SELECT 1 FROM task_tree tt
        WHERE e.source_task_ids ? tt.id::text
      )
    ),
    updated_goals AS (
      UPDATE goals
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid, updated_at = NOW()
      WHERE id = ${GOAL_ID}::uuid
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_tasks AS (
      UPDATE tasks
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid, updated_at = NOW()
      WHERE id IN (SELECT id FROM task_tree)
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_work_products AS (
      UPDATE work_products
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid
      WHERE id IN (SELECT id FROM wp_set)
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_hive_memory AS (
      UPDATE hive_memory
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid, updated_at = NOW()
      WHERE source_task_id IN (SELECT id FROM task_tree)
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_role_memory AS (
      UPDATE role_memory
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid, updated_at = NOW()
      WHERE source_task_id IN (SELECT id FROM task_tree)
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_memory_embeddings AS (
      UPDATE memory_embeddings
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid
      WHERE source_type = 'work_product'
        AND source_id IN (SELECT id FROM wp_set)
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_entities AS (
      UPDATE entities
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid, updated_at = NOW()
      WHERE id IN (SELECT id FROM entity_set)
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_insights AS (
      UPDATE insights
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid, updated_at = NOW()
      WHERE id IN (SELECT id FROM insight_set)
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    ),
    updated_schedules AS (
      UPDATE schedules
      SET hive_id = ${DESTINATION_HIVE_ID}::uuid
      WHERE id = ${SCHEDULE_ID}::uuid
        AND hive_id = ${SOURCE_HIVE_ID}::uuid
      RETURNING 1
    )
    SELECT 'goals' AS artifact, count(*)::int FROM updated_goals
    UNION ALL SELECT 'tasks', count(*)::int FROM updated_tasks
    UNION ALL SELECT 'work_products', count(*)::int FROM updated_work_products
    UNION ALL SELECT 'hive_memory', count(*)::int FROM updated_hive_memory
    UNION ALL SELECT 'role_memory', count(*)::int FROM updated_role_memory
    UNION ALL SELECT 'memory_embeddings', count(*)::int FROM updated_memory_embeddings
    UNION ALL SELECT 'entities', count(*)::int FROM updated_entities
    UNION ALL SELECT 'insights', count(*)::int FROM updated_insights
    UNION ALL SELECT 'schedules', count(*)::int FROM updated_schedules
  `;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(`[migrate-goal-24f56884] DATABASE_URL is required`);
  }

  const apply = process.env[CONFIRM_ENV] === "1";
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const beforeCounts = await queryHiveCounts(sql);
    const beforeScalarCounts = await queryScalarCounts(sql);
    const goal = await queryGoal(sql);
    const hives = await queryHives(sql);
    const schedule = await querySchedule(sql);
    const insights = await queryInsights(sql);

    if (!goal) {
      throw new Error(`[migrate-goal-24f56884] goal ${GOAL_ID} was not found`);
    }
    if (goal.hive_id !== SOURCE_HIVE_ID && !apply) {
      throw new Error(
        `[migrate-goal-24f56884] goal is not in source hive; current hive_id=${goal.hive_id}`,
      );
    }
    if (hives.length !== 2) {
      throw new Error(`[migrate-goal-24f56884] expected source and destination hives to exist`);
    }
    const destination = hives.find((hive) => hive.id === DESTINATION_HIVE_ID);
    if (destination?.slug !== "hivewright") {
      throw new Error(
        `[migrate-goal-24f56884] destination hive slug mismatch; expected hivewright, got ${destination?.slug ?? "missing"}`,
      );
    }

    assertExpectedBefore(beforeCounts, beforeScalarCounts);

    const result: Record<string, unknown> = {
      mode: apply ? "apply" : "dry-run",
      repoPath: process.cwd(),
      gitBranch: getGitValue(["branch", "--show-current"]),
      gitHead: getGitValue(["rev-parse", "--short", "HEAD"]),
      sourceHiveId: SOURCE_HIVE_ID,
      destinationHiveId: DESTINATION_HIVE_ID,
      goal,
      hives,
      schedule,
      beforeCounts,
      beforeScalarCounts,
      insights,
      mixedSourceInsightIds: insights
        .filter((insight) => insight.has_external_world_scan_wp)
        .map((insight) => insight.id),
      action: apply
        ? "migrated all denormalized hive_id lineage rows, including all three insight rows"
        : `dry run only; set ${CONFIRM_ENV}=1 to apply`,
    };

    if (apply) {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('migrate-goal-24f56884'))`;
        const lockedGoal = await queryGoal(tx);
        if (lockedGoal?.hive_id !== SOURCE_HIVE_ID) {
          throw new Error(
            `[migrate-goal-24f56884] locked goal source assertion failed; current hive_id=${lockedGoal?.hive_id ?? "missing"}`,
          );
        }
        const updateCounts = await updateLineage(tx);
        assertMoveCounts(updateCounts);
        const afterCounts = await queryHiveCounts(tx);
        assertAfter(afterCounts);
        result.updateCounts = Object.fromEntries(
          updateCounts.map((row) => [row.artifact, toInt(row.count)]),
        );
        result.afterCounts = afterCounts;
        result.afterSchedule = await querySchedule(tx);
        result.afterInsights = await queryInsights(tx);
      });
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
