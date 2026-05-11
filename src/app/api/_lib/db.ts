import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://hivewright@localhost:5432/hivewrightv2";

const globalForDb = globalThis as unknown as { sql: ReturnType<typeof postgres> };

export const sql = globalForDb.sql ?? postgres(DATABASE_URL);

if (process.env.NODE_ENV !== "production") {
  globalForDb.sql = sql;
}
