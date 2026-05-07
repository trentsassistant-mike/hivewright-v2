import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { markUnresolvable } from "../../src/dispatcher/mark-unresolvable";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('mark-unresolvable-test-biz', 'Test Biz', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('test-role', 'Test Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("markUnresolvable", () => {
  it("sets status, failure_reason, updated_at on the named task", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief)
      VALUES (${bizId}, 'test-role', 'owner', 'failed', 5, 't', 'b')
      RETURNING id
    `;

    await markUnresolvable(sql, row.id, "stuck");

    const [after] = await sql<{ status: string; failure_reason: string; updated_at: Date }[]>`
      SELECT status, failure_reason, updated_at FROM tasks WHERE id = ${row.id}
    `;
    expect(after.status).toBe("unresolvable");
    expect(after.failure_reason).toBe("stuck");
    expect(after.updated_at).toBeInstanceOf(Date);
  });

  it("is a no-op when the task id does not exist", async () => {
    // UPDATE ... WHERE id = <nonexistent> affects zero rows in Postgres
    // and does NOT throw — the helper must surface that as a silent no-op.
    await expect(
      markUnresolvable(sql, "00000000-0000-0000-0000-000000000000", "x"),
    ).resolves.toBeUndefined();
  });
});
