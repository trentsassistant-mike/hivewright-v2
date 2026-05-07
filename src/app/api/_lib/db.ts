import postgres from "postgres";
import { requireEnv } from "@/lib/required-env";

const DATABASE_URL = requireEnv("DATABASE_URL");

const globalForDb = globalThis as unknown as { sql: ReturnType<typeof postgres> };

export const sql = globalForDb.sql ?? postgres(DATABASE_URL);

if (process.env.NODE_ENV !== "production") {
  globalForDb.sql = sql;
}
