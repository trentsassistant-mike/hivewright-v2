import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledMigrationFiles } from "@/db/migration-metadata";
import { assertBundledMigrationsApplied } from "@/db/startup-migration-assertion";

let repoRoot: string;
let appliedHashes: string[];

async function writeMigration(name: string, sqlText: string): Promise<void> {
  await writeFile(path.join(repoRoot, "drizzle", `${name}.sql`), sqlText, "utf8");
}

function createFakeSql(): Sql {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join("");
    if (query.includes("to_regclass")) {
      return [{ exists: "drizzle.__drizzle_migrations" }];
    }
    if (query.includes("SELECT hash")) {
      return appliedHashes.map((hash) => ({ hash }));
    }
    throw new Error(`unexpected SQL in fake assertion test: ${query}`);
  }) as unknown as Sql;
}

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "hivewright-migration-assertion-"));
  await mkdir(path.join(repoRoot, "drizzle"));
  await writeMigration("9001_assertion_fixture_one", "SELECT 9001;\n");
  await writeMigration("9002_assertion_fixture_two", "SELECT 9002;\n");
  appliedHashes = [];
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("startup migration assertion", () => {
  it("fails closed and lists bundled SQL files missing from drizzle metadata", async () => {
    await expect(
      assertBundledMigrationsApplied(createFakeSql(), { processName: "test-process", repoRoot }),
    ).rejects.toThrow(
      /Missing migrations: 9001_assertion_fixture_one, 9002_assertion_fixture_two/,
    );
  });

  it("passes when every bundled SQL file hash is present in drizzle metadata", async () => {
    appliedHashes = getBundledMigrationFiles(repoRoot)
      .map((migration) => migration.hash);

    await expect(
      assertBundledMigrationsApplied(createFakeSql(), { processName: "test-process", repoRoot }),
    ).resolves.toBeUndefined();
  });
});
