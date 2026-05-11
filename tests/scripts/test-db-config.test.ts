import { describe, expect, it } from "vitest";
import {
  buildTestDatabaseConfigFromEnv,
  defaultLocalCandidates,
  withDatabase,
} from "../../scripts/lib/test-db-config";

describe("test database config", () => {
  it("uses explicit TEST_DATABASE_URL safely", () => {
    const config = buildTestDatabaseConfigFromEnv({
      TEST_DATABASE_URL: "postgresql://postgres@localhost:5432/hivewrightv2_test_custom",
    });

    expect(config).toMatchObject({
      adminUrl: "postgresql://postgres@localhost:5432/postgres",
      testUrl: "postgresql://postgres@localhost:5432/hivewrightv2_test_custom",
      databaseName: "hivewrightv2_test_custom",
      source: "env",
    });
  });

  it("refuses non-test database names", () => {
    expect(() => buildTestDatabaseConfigFromEnv({
      TEST_DATABASE_URL: "postgresql://postgres@localhost:5432/hivewright",
    })).toThrow(/must start with 'hivewrightv2_test'/);
  });

  it("builds public-safe local candidates without a password placeholder", () => {
    const candidates = defaultLocalCandidates({ USER: "tester", PGPORT: "15432", PGPASSFILE: "/tmp/does-not-exist" });

    expect(candidates[0]).toMatchObject({
      adminUrl: "postgresql://tester@localhost:15432/postgres",
      testUrl: "postgresql://tester@localhost:15432/hivewrightv2_test",
      databaseName: "hivewrightv2_test",
      source: "auto",
    });
  });

  it("can switch a URL to another database", () => {
    expect(withDatabase("postgresql://user@localhost:5433/hivewrightv2_test", "postgres"))
      .toBe("postgresql://user@localhost:5433/postgres");
  });
});
