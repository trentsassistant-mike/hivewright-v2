import { spawnSync } from "node:child_process";
import postgres from "postgres";

const TEST_DB_NAME_PREFIX = "hivewright_test";
const DEFAULT_TEST_DB_URL = `postgresql://hivewright:hivewright@localhost:5432/${TEST_DB_NAME_PREFIX}`;
const DEFAULT_ADMIN_URL = "postgresql://hivewright:hivewright@localhost:5432/postgres";
const VITEST_FILES = [
  "tests/api/work-internal-auth.test.ts",
  "tests/initiative-engine/follow-up-submission-auth-path.test.ts",
  "tests/initiative-engine/run-initiative-evaluation.test.ts",
  "tests/dispatcher/schedule-timer-initiative.test.ts",
  "tests/api/initiative-runs-api.test.ts",
  "tests/app/api/brief-initiative.test.ts",
];

function buildRunDbUrl(): { dbName: string; testDbUrl: string } {
  const baseUrl = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DB_URL);
  const baseDbName = decodeURIComponent(baseUrl.pathname.replace(/^\//, ""));
  if (!baseDbName.startsWith(TEST_DB_NAME_PREFIX)) {
    throw new Error(
      `[dormant-goal-verification] base test DB '${baseDbName}' must start with '${TEST_DB_NAME_PREFIX}'`,
    );
  }

  const suffix = `dormant_goal_${Date.now()}_${process.pid}`.replace(/[^a-z0-9_]/g, "_");
  const dbName = `${TEST_DB_NAME_PREFIX}_${suffix}`.slice(0, 63);
  baseUrl.pathname = `/${dbName}`;
  return {
    dbName,
    testDbUrl: baseUrl.toString(),
  };
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${dbName}
        AND pid <> pg_backend_pid()
    `;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function main() {
  const adminUrl = process.env.TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  const { dbName, testDbUrl } = buildRunDbUrl();
  const env = {
    ...process.env,
    TEST_DATABASE_URL: testDbUrl,
    DATABASE_URL: testDbUrl,
    TEST_ADMIN_URL: adminUrl,
  };

  console.log(`[dormant-goal-verification] isolated test DB: ${dbName}`);

  let exitCode = 1;
  try {
    exitCode = runCommand("npx", ["vitest", "run", ...VITEST_FILES], env);
  } finally {
    await dropDatabase(adminUrl, dbName);
    console.log(`[dormant-goal-verification] dropped isolated test DB: ${dbName}`);
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("[dormant-goal-verification] failed:", error);
  process.exit(1);
});
