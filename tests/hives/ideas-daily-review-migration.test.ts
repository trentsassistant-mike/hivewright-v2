import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "drizzle",
  "0037_ideas_daily_review_schedule.sql",
);

beforeEach(async () => {
  await truncateAll(sql);
});

describe("0037_ideas_daily_review_schedule.sql", () => {
  it("backfills exactly one ideas-daily-review schedule for each existing hive and stays idempotent", async () => {
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'ideas-a', 'Ideas A', 'digital'),
        ('22222222-2222-2222-2222-222222222222', 'ideas-b', 'Ideas B', 'service')
    `;

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        '22222222-2222-2222-2222-222222222222'::uuid,
        '0 9 * * *',
        ${sql.json({
          kind: "ideas-daily-review",
          assignedTo: "ideas-curator",
          title: "Ideas daily review",
          brief: "(populated at run time)",
        })},
        true,
        'preexisting'
      )
    `;

    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
    await sql.unsafe(migrationSql);
    await sql.unsafe(migrationSql);

    const rows = await sql<{
      hive_id: string;
      cron_expression: string;
      created_by: string;
      task_template: { kind: string; assignedTo: string; title: string };
      next_run_at: Date | null;
    }[]>`
      SELECT hive_id, cron_expression, created_by, task_template, next_run_at
      FROM schedules
      WHERE task_template ->> 'kind' = 'ideas-daily-review'
      ORDER BY hive_id ASC
    `;

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.cron_expression === "0 9 * * *")).toBe(true);
    expect(rows.every((row) => row.task_template.kind === "ideas-daily-review")).toBe(true);
    expect(rows.every((row) => row.task_template.assignedTo === "ideas-curator")).toBe(true);
    expect(rows.every((row) => row.task_template.title === "Ideas daily review")).toBe(true);
    const createdByByHive = new Map(rows.map((row) => [row.hive_id, row.created_by]));
    expect(createdByByHive.get("11111111-1111-1111-1111-111111111111")).toBe(
      "migration:0037_ideas_daily_review_schedule",
    );
    expect(createdByByHive.get("22222222-2222-2222-2222-222222222222")).toBe(
      "preexisting",
    );

    const insertedRow = rows.find(
      (row) => row.hive_id === "11111111-1111-1111-1111-111111111111",
    );
    expect(insertedRow?.next_run_at).not.toBeNull();

    const [{ count }] = (await sql`
      SELECT COUNT(*)::int AS count
      FROM schedules
      WHERE hive_id = '22222222-2222-2222-2222-222222222222'::uuid
        AND task_template ->> 'kind' = 'ideas-daily-review'
    `) as unknown as { count: number }[];
    expect(count).toBe(1);
  });
});
