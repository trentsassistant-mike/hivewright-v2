import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "drizzle",
  "0053_backfill_world_scan_next_run.sql",
);

beforeEach(async () => {
  await truncateAll(sql);
});

describe("0053_backfill_world_scan_next_run.sql", () => {
  it("backfills existing Daily world scan rows without creating schedules or touching populated rows", async () => {
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'world-a', 'World A', 'digital'),
        ('22222222-2222-2222-2222-222222222222', 'world-b', 'World B', 'service')
    `;

    const populatedNextRunAt = new Date(Date.now() + 3 * 60 * 60 * 1000);

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES
        (
          '11111111-1111-1111-1111-111111111111'::uuid,
          '0 7 * * *',
          ${sql.json({
            assignedTo: "research-analyst",
            title: "Daily world scan",
            brief: "existing null row",
          })},
          true,
          NULL,
          'preexisting-null'
        ),
        (
          '22222222-2222-2222-2222-222222222222'::uuid,
          '0 7 * * *',
          ${sql.json({
            assignedTo: "research-analyst",
            title: "Daily world scan",
            brief: "existing populated row",
          })},
          true,
          ${populatedNextRunAt},
          'preexisting-populated'
        )
    `;

    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
    await sql.unsafe(migrationSql);
    await sql.unsafe(migrationSql);

    const rows = await sql<{
      hive_id: string;
      created_by: string;
      next_run_at: Date | null;
    }[]>`
      SELECT hive_id, created_by, next_run_at
      FROM schedules
      WHERE task_template ->> 'title' = 'Daily world scan'
      ORDER BY hive_id ASC
    `;

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.next_run_at !== null)).toBe(true);

    const backfilled = rows.find(
      (row) => row.hive_id === "11111111-1111-1111-1111-111111111111",
    );
    expect(backfilled?.created_by).toBe("preexisting-null");
    expect(backfilled!.next_run_at!.getTime()).toBeGreaterThan(Date.now());

    const untouched = rows.find(
      (row) => row.hive_id === "22222222-2222-2222-2222-222222222222",
    );
    expect(untouched?.created_by).toBe("preexisting-populated");
    expect(untouched!.next_run_at!.getTime()).toBe(populatedNextRunAt.getTime());
  });
});
