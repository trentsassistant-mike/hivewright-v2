import type { Sql } from "postgres";
import { assertBundledMigrationsApplied } from "../db/startup-migration-assertion";

export async function assertDispatcherSchemaVersion(
  sql: Sql,
  repoRoot = process.cwd(),
): Promise<void> {
  await assertBundledMigrationsApplied(sql, { processName: "dispatcher", repoRoot });
}
