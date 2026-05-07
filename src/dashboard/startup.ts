import postgres, { type Sql } from "postgres";
import { assertBundledMigrationsApplied } from "@/db/startup-migration-assertion";
import { requireEnv } from "@/lib/required-env";

const DATABASE_URL = requireEnv("DATABASE_URL");

export async function assertDashboardStartupMigrations(sql?: Sql): Promise<void> {
  if (sql) {
    await assertBundledMigrationsApplied(sql, { processName: "dashboard" });
    return;
  }

  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    await assertBundledMigrationsApplied(client, { processName: "dashboard" });
  } finally {
    await client.end();
  }
}
