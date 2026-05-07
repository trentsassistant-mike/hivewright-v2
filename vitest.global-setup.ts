/**
 * Vitest globalSetup: runs once before any test file is loaded.
 * Ensures hivewright_test exists and is migrated. Idempotent — re-running
 * the suite without dropping the DB just confirms migrations are current.
 *
 * No teardown needed: the test-db pool lives in the test worker process,
 * which vitest tears down when the run completes. Per-file `afterAll`
 * blocks must NOT call closeTestSql() — the pool is shared across every
 * test file and closing it mid-run breaks every file that hasn't run yet.
 */
import { spawnSync } from "node:child_process";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://hivewright:hivewright@localhost:5432/hivewright_test";

export default async function setup() {
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const result = spawnSync("npm", ["run", "test:setup-db"], {
    stdio: "inherit",
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_DATABASE_URL,
      DATABASE_URL: TEST_DATABASE_URL,
    },
  });
  if (result.error) {
    throw new Error(
      `[vitest globalSetup] failed to spawn npm: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `[vitest globalSetup] test:setup-db failed with exit code ${result.status}`,
    );
  }

  await import("./tests/_lib/test-db");

  return async () => {
    process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { closeTestSql } = await import("./tests/_lib/test-db");
    await closeTestSql();
  };
}
