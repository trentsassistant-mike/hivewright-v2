import type { Sql } from "postgres";
import {
  DRIZZLE_MIGRATIONS_SCHEMA,
  DRIZZLE_MIGRATIONS_TABLE,
  getBundledMigrationFiles,
} from "./migration-metadata";

export interface StartupMigrationAssertionResult {
  expectedCount: number;
  appliedCount: number;
  missingMigrationNames: string[];
}

async function relationExists(sql: Sql, relationName: string): Promise<boolean> {
  const [row] = await sql<{ exists: string | null }[]>`
    SELECT to_regclass(${relationName})::text AS exists
  `;
  return row?.exists !== null;
}

function formatMissingMigrations(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

export async function getStartupMigrationAssertionState(
  sql: Sql,
  repoRoot = process.cwd(),
): Promise<StartupMigrationAssertionResult> {
  const expected = getBundledMigrationFiles(repoRoot);
  const relation = `${DRIZZLE_MIGRATIONS_SCHEMA}.${DRIZZLE_MIGRATIONS_TABLE}`;

  if (expected.length === 0) {
    throw new Error(`[startup-migrations] no bundled migration SQL files found`);
  }

  if (!(await relationExists(sql, relation))) {
    return {
      expectedCount: expected.length,
      appliedCount: 0,
      missingMigrationNames: expected.map((migration) => migration.name),
    };
  }

  const appliedRows = await sql<{ hash: string }[]>`
    SELECT hash
    FROM drizzle.__drizzle_migrations
  `;
  const appliedHashes = new Set(appliedRows.map((row) => row.hash));
  const missingMigrationNames = expected
    .filter((migration) => !appliedHashes.has(migration.hash))
    .map((migration) => migration.name);

  return {
    expectedCount: expected.length,
    appliedCount: appliedRows.length,
    missingMigrationNames,
  };
}

export async function assertBundledMigrationsApplied(
  sql: Sql,
  options: {
    processName: "dispatcher" | "dashboard" | string;
    repoRoot?: string;
  },
): Promise<void> {
  const state = await getStartupMigrationAssertionState(sql, options.repoRoot);

  if (state.missingMigrationNames.length > 0) {
    throw new Error(
      `[${options.processName}] Startup migration assertion failed: bundled migration SQL files ` +
        `are not applied in ${DRIZZLE_MIGRATIONS_SCHEMA}.${DRIZZLE_MIGRATIONS_TABLE}. ` +
        `Missing migrations: ${formatMissingMigrations(state.missingMigrationNames)}. ` +
        `Applied rows: ${state.appliedCount}; bundled SQL files: ${state.expectedCount}. ` +
        `Run npm run db:migrate:app before starting ${options.processName}.`,
    );
  }

  console.log(
    `[${options.processName}] Startup migration assertion passed: ` +
      `${state.expectedCount} bundled SQL migrations are present in ` +
      `${DRIZZLE_MIGRATIONS_SCHEMA}.${DRIZZLE_MIGRATIONS_TABLE}.`,
  );
}
