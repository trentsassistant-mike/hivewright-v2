import { describe, it, expect, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { createFixtureNamespace, testSql as sql, truncateAll } from "./test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

// Pool is closed exactly once at end-of-run by vitest globalSetup teardown.
// Do NOT call closeTestSql() here — the pool is shared with every other
// test file and closing it mid-run breaks them all.
afterAll(async () => {
  await truncateAll(sql);
});

describe("test-db helper", () => {
  it("connects to a hivewrightv2_test-prefixed database, not prod", async () => {
    const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    expect(row.db.startsWith("hivewrightv2_test")).toBe(true);
  });

  it("holds a run-level advisory lock for the effective test database", async () => {
    const [dbRow] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    const outsider = postgres(
      process.env.TEST_DATABASE_URL ??
        process.env.DATABASE_URL ??
        "postgresql://hivewright:placeholder@localhost:5432/hivewrightv2_test",
      { max: 1 },
    );

    try {
      const [row] = await outsider<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${dbRow.db})::bigint) AS locked
      `;
      expect(row.locked).toBe(false);
    } finally {
      await outsider.end({ timeout: 5 });
    }
  });

  it("truncateAll wipes user data but preserves role_templates seed", async () => {
    // Insert role_template seed (treated as read-only by truncateAll).
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('test-db-helper-role', 'TDH', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    // Insert user data (will be wiped).
    await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('test-db-helper-biz', 'TDH', 'digital')
    `;

    await truncateAll(sql);

    const biz = await sql`SELECT 1 FROM hives WHERE slug = 'test-db-helper-biz'`;
    expect(biz.length).toBe(0);

    const role = await sql`SELECT 1 FROM role_templates WHERE slug = 'test-db-helper-role'`;
    expect(role.length).toBe(1);

    // Cleanup the seed we added.
    await sql`DELETE FROM role_templates WHERE slug = 'test-db-helper-role'`;
  });

  it("truncateAll can fully reset preserved seed tables when a suite opts in", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('test-db-helper-reset-role', 'TDH Reset', 'executor', 'claude-code')
    `;

    await truncateAll(sql, { preserveReadOnlyTables: false });

    const role = await sql`SELECT 1 FROM role_templates WHERE slug = 'test-db-helper-reset-role'`;
    expect(role.length).toBe(0);
  });

  it("truncateAll handles FK relationships via CASCADE", async () => {
    // Create a parent + child row pair that previously broke prefix-DELETE
    // helpers (hive_memory references tasks.id).
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('tdh-fk-biz', 'FK', 'digital') RETURNING id
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('tdh-fk-role', 'FK', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    const [task] = await sql`
      INSERT INTO tasks (hive_id, title, brief, assigned_to, created_by, status)
      VALUES (${biz.id}, 'tdh-fk-task', 'b', 'tdh-fk-role', 'test-db-helper', 'pending')
      RETURNING id
    `;
    await sql`
      INSERT INTO hive_memory (hive_id, category, content, source_task_id, sensitivity)
      VALUES (${biz.id}, 'fact', 'tdh-fk-mem', ${task.id}, 'internal')
    `;

    // This would FK-violate without CASCADE.
    await expect(truncateAll(sql)).resolves.toBeUndefined();

    const mem = await sql`SELECT 1 FROM hive_memory WHERE content = 'tdh-fk-mem'`;
    expect(mem.length).toBe(0);
    const task2 = await sql`SELECT 1 FROM tasks WHERE title = 'tdh-fk-task'`;
    expect(task2.length).toBe(0);

    await sql`DELETE FROM role_templates WHERE slug = 'tdh-fk-role'`;
  });

  it("createFixtureNamespace generates distinct values within the same test scope", () => {
    const first = createFixtureNamespace("helper");
    const second = createFixtureNamespace("helper");

    expect(first.key).not.toBe(second.key);
    expect(first.email("owner")).not.toBe(second.email("owner"));
    expect(first.slug("biz")).not.toBe(second.slug("biz"));
    expect(first.uuid("biz")).not.toBe(second.uuid("biz"));
  });
});
