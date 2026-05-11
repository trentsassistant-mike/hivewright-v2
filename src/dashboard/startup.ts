import postgres, { type Sql } from "postgres";
import { assertBundledMigrationsApplied } from "@/db/startup-migration-assertion";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://hivewright@localhost:5432/hivewrightv2";

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
