import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { applyOutOfJournalMigrations, MIGRATIONS_FOLDER } from "./lib/drizzle-migrations";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await sql`SELECT current_database() AS db`;
    console.log(`[migrate-app-db] connected to ${row.db}`);

    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      console.log("[migrate-app-db] pgvector enabled");
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "42501" || msg.includes("permission denied") || msg.includes("superuser")) {
        throw new Error(
          `[migrate-app-db] cannot install pgvector: ${msg}\n` +
          "Install the extension with a superuser and re-run this script.",
        );
      }
      throw err;
    }

    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("[migrate-app-db] journaled migrations applied");

    await applyOutOfJournalMigrations(sql);
    console.log("[migrate-app-db] app database migrations complete");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[migrate-app-db] failed:", err);
  process.exit(1);
});
