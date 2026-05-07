import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import {
  APP_MIGRATIONS_TABLE,
  DRIZZLE_MIGRATIONS_SCHEMA,
  DRIZZLE_MIGRATIONS_TABLE,
  getBundledMigrationFiles,
} from "../../src/db/migration-metadata";

export const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

export const OUT_OF_JOURNAL_MIGRATIONS = [
  "0017_goal_comments.sql",
  "0018_goal_last_woken_sprint.sql",
  "0019_role_fallback_adapter.sql",
  "0020_connector_framework.sql",
  "0021_oauth_states.sql",
  "0022_ai_board.sql",
  "0023_users_and_memberships.sql",
  "0024_role_tools_config.sql",
  "0025_drop_active_departments.sql",
  "0026_insight_curator.sql",
  "0027_decisions_kind.sql",
  "0028_native_ea.sql",
  "0029_decisions_ea_review.sql",
  "0030_decisions_ea_review_notify.sql",
  "0031_hive_supervisor.sql",
  "0032_role_terminal_flag.sql",
  "0033_hive_mission.sql",
  "0034_hive_targets.sql",
  "0035_hive_target_status.sql",
  "0036_hive_ideas.sql",
  "0037_ideas_daily_review_schedule.sql",
  "0038_embedding_config.sql",
  "0039_role_concurrency_limit.sql",
  "0040_embedding_reembed_progress.sql",
  "0041_idea_attachments.sql",
  "0042_initiative_runs.sql",
  "0043_initiative_evaluation_schedule.sql",
  "0044_tasks_completed_failure_reason_cleanup.sql",
  "0046_drop_tasks_completed_failure_reason_check.sql",
  "0047_voice_ea.sql",
  "0048_ea_messages_source.sql",
  "0049_hive_system_fixtures.sql",
  "0050_dashboard_ea_chat.sql",
  "0052_remove_dashboard_chat_adapter_config.sql",
  "0053_backfill_world_scan_next_run.sql",
  "0054_task_adapter_override.sql",
  "0055_task_quality_signals.sql",
  "0056_task_quality_feedback_schedule.sql",
  "0057_quality_sprint3_controls.sql",
  "0058_decision_selected_option.sql",
  "0059_decision_comment_wake.sql",
  "0060_ea_hive_switch_audit.sql",
  "0062_decisions_resolved_by.sql",
  "0063_qa_fixture_markers.sql",
  "0064_quality_feedback_split_lanes.sql",
  "0077_task_workspaces.sql",
  "0081_hive_creation_pause.sql",
  "0082_hive_runnable_pause.sql",
  "0096_voice_sessions_transport.sql",
  "0097_voice_ea_connector_rename.sql",
] as const;

async function ensureAppMigrationMetadata(sql: Sql): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${DRIZZLE_MIGRATIONS_SCHEMA}"`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${DRIZZLE_MIGRATIONS_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${DRIZZLE_MIGRATIONS_SCHEMA}"."${APP_MIGRATIONS_TABLE}" (
      migration_name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
}

async function markAppMigrationApplied(sql: Sql, migrationName: string): Promise<void> {
  await sql.unsafe(
    `
      INSERT INTO "${DRIZZLE_MIGRATIONS_SCHEMA}"."${APP_MIGRATIONS_TABLE}" (migration_name)
      VALUES ($1)
      ON CONFLICT (migration_name) DO UPDATE SET applied_at = EXCLUDED.applied_at
    `,
    [migrationName],
  );
}

async function markDrizzleMigrationApplied(sql: Sql, migrationName: string): Promise<void> {
  const migration = getBundledMigrationFiles(path.join(MIGRATIONS_FOLDER, ".."))
    .find((candidate) => candidate.name === migrationName);
  if (!migration) return;

  await sql.unsafe(
    `
      INSERT INTO "${DRIZZLE_MIGRATIONS_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}" (hash, created_at)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1
        FROM "${DRIZZLE_MIGRATIONS_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}"
        WHERE hash = $1
      )
    `,
    [migration.hash, migration.version.id],
  );
}

export async function applyOutOfJournalMigrations(sql: Sql): Promise<void> {
  await ensureAppMigrationMetadata(sql);

  const hivesExists = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'hives'
  `;

  if (hivesExists.length === 0) {
    const renamePath = path.join(MIGRATIONS_FOLDER, "0016_rename_businesses_to_hives.sql");
    if (fs.existsSync(renamePath)) {
      await sql.unsafe(fs.readFileSync(renamePath, "utf8"));
      await markAppMigrationApplied(sql, "0016_rename_businesses_to_hives");
      await markDrizzleMigrationApplied(sql, "0016_rename_businesses_to_hives");
      console.log("[drizzle-migrations] applied 0016_rename_businesses_to_hives");
    }
  } else {
    await markDrizzleMigrationApplied(sql, "0016_rename_businesses_to_hives");
  }

  for (const name of OUT_OF_JOURNAL_MIGRATIONS) {
    const migrationPath = path.join(MIGRATIONS_FOLDER, name);
    if (!fs.existsSync(migrationPath)) continue;
    await sql.unsafe(fs.readFileSync(migrationPath, "utf8"));
    const migrationName = name.replace(/\.sql$/, "");
    await markAppMigrationApplied(sql, migrationName);
    await markDrizzleMigrationApplied(sql, migrationName);
  }

  console.log("[drizzle-migrations] applied out-of-journal migrations");
}
