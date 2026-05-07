import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOutOfJournalMigrations } from "../../scripts/lib/drizzle-migrations";
import {
  DRIZZLE_MIGRATIONS_SCHEMA,
  DRIZZLE_MIGRATIONS_TABLE,
  getBundledMigrationFiles,
} from "@/db/migration-metadata";
import { testSql as sql } from "../_lib/test-db";

vi.mock("@/dispatcher/task-claimer", () => ({
  claimNextTask: vi.fn(async () => null),
  completeTask: vi.fn(async () => undefined),
  blockTask: vi.fn(async () => undefined),
}));

const { Dispatcher } = await import("@/dispatcher");
const { claimNextTask } = await import("@/dispatcher/task-claimer");

async function restoreMigrationMarkers() {
  await applyOutOfJournalMigrations(sql);
}

beforeEach(async () => {
  vi.mocked(claimNextTask).mockClear();
  await restoreMigrationMarkers();
});

afterEach(async () => {
  await restoreMigrationMarkers();
  vi.restoreAllMocks();
});

describe("dispatcher startup schema-version assertion", () => {
  it("fails before entering the claim loop when bundled migrations are missing from drizzle metadata", async () => {
    const missing = getBundledMigrationFiles()
      .filter((migration) => migration.name >= "0063_qa_fixture_markers");

    await sql.unsafe(
      `
        DELETE FROM "${DRIZZLE_MIGRATIONS_SCHEMA}"."${DRIZZLE_MIGRATIONS_TABLE}"
        WHERE hash = ANY($1::text[])
      `,
      [missing.map((migration) => migration.hash)],
    );

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dispatcher = new Dispatcher({
      pollIntervalMs: 60_000,
      watchdogIntervalMs: 60_000,
      scheduleIntervalMs: 60_000,
      sprintCheckIntervalMs: 60_000,
      supervisorWakeReconciliationIntervalMs: 60_000,
      modelHealthRenewalIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      maxTaskRuntimeMs: 60_000,
      maxRetries: 3,
      maxDoctorAttempts: 2,
      synthesisIntervalMs: 60_000,
      maxConcurrentTasks: 1,
    });

    await expect(dispatcher.start()).rejects.toThrow(
      /Startup migration assertion failed: bundled migration SQL files are not applied[\s\S]*0063_qa_fixture_markers[\s\S]*0064_quality_feedback_split_lanes/,
    );

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Startup migration assertion failed"),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("0063_qa_fixture_markers"),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("0064_quality_feedback_split_lanes"),
    );
    expect(claimNextTask).not.toHaveBeenCalled();
  });
});
