import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "drizzle",
  "0043_initiative_evaluation_schedule.sql",
);

beforeEach(async () => {
  await truncateAll(sql);
});

describe("0043_initiative_evaluation_schedule.sql", () => {
  it("backfills exactly one initiative-evaluation schedule for each existing hive and stays idempotent", async () => {
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'initiative-a', 'Initiative A', 'digital'),
        ('22222222-2222-2222-2222-222222222222', 'initiative-b', 'Initiative B', 'service')
    `;

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        '22222222-2222-2222-2222-222222222222'::uuid,
        '0 * * * *',
        ${sql.json({
          kind: "initiative-evaluation",
          assignedTo: "initiative-engine",
          title: "Initiative evaluation",
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
      task_template: { kind: string; assignedTo: string; title: string; brief: string };
      next_run_at: Date | null;
    }[]>`
      SELECT hive_id, cron_expression, created_by, task_template, next_run_at
      FROM schedules
      WHERE task_template ->> 'kind' = 'initiative-evaluation'
      ORDER BY hive_id ASC
    `;

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.cron_expression === "0 * * * *")).toBe(true);
    expect(rows.every((row) => row.task_template.kind === "initiative-evaluation")).toBe(true);
    expect(rows.every((row) => row.task_template.assignedTo === "initiative-engine")).toBe(true);
    expect(rows.every((row) => row.task_template.title === "Initiative evaluation")).toBe(true);
    expect(rows.every((row) => row.task_template.brief === "(populated at run time)")).toBe(true);

    const createdByByHive = new Map(rows.map((row) => [row.hive_id, row.created_by]));
    expect(createdByByHive.get("11111111-1111-1111-1111-111111111111")).toBe(
      "migration:0043_initiative_evaluation_schedule",
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
        AND task_template ->> 'kind' = 'initiative-evaluation'
    `) as unknown as { count: number }[];
    expect(count).toBe(1);
  });
});
