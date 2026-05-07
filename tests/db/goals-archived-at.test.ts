import { describe, it, expect } from "vitest";
import { testSql as sql } from "../_lib/test-db";

describe("goals.archived_at", () => {
  it("archived_at column exists and is timestamptz nullable", async () => {
    const [col] = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'goals' AND column_name = 'archived_at'
    `;
    expect(col).toBeDefined();
    expect(col.data_type).toBe("timestamp with time zone");
    expect(col.is_nullable).toBe("YES");
  });

  it("partial index idx_goals_archived_at_null exists", async () => {
    const [idx] = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'goals' AND indexname = 'idx_goals_archived_at_null'
    `;
    expect(idx).toBeDefined();
    expect(idx.indexdef).toMatch(/WHERE.*archived_at IS NULL/);
  });
});
