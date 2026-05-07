/**
 * Vitest globalSetup: runs once before any test file is loaded.
 * Ensures a hivewright_test-prefixed database exists and is migrated.
 *
 * If TEST_DATABASE_URL/TEST_ADMIN_URL are not set, setup auto-detects a
 * local Postgres admin connection on localhost ports 5432/5433 using the
 * current OS user or postgres. This keeps fresh self-hosted clones testable
 * without baking private machine credentials into the public repo.
 */
import { spawnSync } from "node:child_process";
import { resolveTestDatabaseConfig } from "./scripts/lib/test-db-config";

export default async function setup() {
  const config = await resolveTestDatabaseConfig();
  process.env.TEST_ADMIN_URL = config.adminUrl;
  process.env.TEST_DATABASE_URL = config.testUrl;
  process.env.DATABASE_URL = config.testUrl;

  const result = spawnSync("npm", ["run", "test:setup-db"], {
    stdio: "inherit",
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_ADMIN_URL: config.adminUrl,
      TEST_DATABASE_URL: config.testUrl,
      DATABASE_URL: config.testUrl,
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
    process.env.TEST_ADMIN_URL = config.adminUrl;
    process.env.TEST_DATABASE_URL = config.testUrl;
    process.env.DATABASE_URL = config.testUrl;
    const { closeTestSql } = await import("./tests/_lib/test-db");
    await closeTestSql();
  };
}
