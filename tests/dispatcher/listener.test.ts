import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTaskListener } from "@/dispatcher/listener";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("createTaskListener", () => {
  it("receives notification when a task is inserted", async () => {
    const received = vi.fn();
    const listener = await createTaskListener(sql, received);

    // Need a hive and role first
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('listener-test', 'Listener Test', 'digital')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING *
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('listener-test-role', 'LT Role', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;

    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${biz.id}, 'listener-test-role', 'owner', 'Listener test', 'Test brief')
      RETURNING *
    `;

    // Give the notification a moment to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toHaveBeenCalledWith(task.id);

    // Cleanup
    await listener.unlisten();
  });
});
