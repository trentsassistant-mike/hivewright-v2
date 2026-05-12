import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { completeTask } from "@/dispatcher/task-claimer";
import { processQaResult } from "@/dispatcher/qa-router";
import { applySupervisorActions } from "@/supervisor/apply-actions";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("database schema", () => {
  it("has all expected tables", async () => {
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    const names = tables.map((t) => t.table_name);
    expect(names).toContain("hives");
    expect(names).toContain("projects");
    expect(names).toContain("role_templates");
    expect(names).toContain("tasks");
    expect(names).toContain("goals");
    expect(names).toContain("decisions");
    expect(names).toContain("schedules");
    expect(names).toContain("credentials");
    expect(names).toContain("embedding_config");
    expect(names).toContain("embedding_reembed_errors");
    expect(names).toContain("role_memory");
    expect(names).toContain("hive_memory");
    expect(names).toContain("insights");
    expect(names).toContain("work_products");
    expect(names).toContain("memory_embeddings");
    expect(names).toContain("action_policies");
    expect(names).toContain("external_action_requests");
  });

  it("tasks table has NOTIFY trigger", async () => {
    const triggers = await sql`
      SELECT trigger_name FROM information_schema.triggers
      WHERE event_object_table = 'tasks'
      AND trigger_name = 'task_insert_notify'
    `;
    expect(triggers.length).toBe(1);
  });

  it("can insert and query a hive", async () => {
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('test-biz-schema', 'Test Hive', 'digital')
      RETURNING *
    `;
    expect(biz.slug).toBe("test-biz-schema");
    expect(biz.name).toBe("Test Hive");
  });

  it("work_products table supports binary image artifact metadata", async () => {
    const columns = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'work_products'
        AND column_name IN (
          'artifact_kind', 'file_path', 'mime_type', 'width', 'height',
          'model_snapshot', 'prompt_tokens', 'output_tokens', 'cost_cents', 'metadata'
        )
      ORDER BY column_name
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).toEqual([
      "artifact_kind",
      "cost_cents",
      "file_path",
      "height",
      "metadata",
      "mime_type",
      "model_snapshot",
      "output_tokens",
      "prompt_tokens",
      "width",
    ]);
  });

  it("can insert a role_template and reference it from tasks", async () => {
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('test-fk-schema', 'FK Test', 'digital')
      RETURNING *
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('test-role-schema', 'Test Role', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${biz.id}, 'test-role-schema', 'owner', 'Test task', 'Do the thing')
      RETURNING *
    `;
    expect(task.assigned_to).toBe("test-role-schema");
    expect(task.status).toBe("pending");
  });

  it("enforces FK on tasks.assigned_to", async () => {
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('test-fk2-schema', 'FK Test 2', 'digital')
      RETURNING *
    `;
    await expect(
      sql`INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
          VALUES (${biz.id}, 'nonexistent-role', 'owner', 'Bad task', 'brief')`
    ).rejects.toThrow();
  });

  it("completion paths leave completed rows with null failure_reason", async () => {
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('test-completed-failure-shape', 'Completed Failure Shape', 'digital')
      RETURNING *
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('test-completed-failure-role', 'Completed Failure Role', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;

    const [direct] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${biz.id}, 'test-completed-failure-role', 'owner', 'Direct completion', 'brief', 'active', 'Reached maximum turn limit')
      RETURNING id
    `;
    await completeTask(sql, direct.id, "Recovered after retry");

    const [qa] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${biz.id}, 'test-completed-failure-role', 'owner', 'QA completion', 'brief', 'in_review', 'Watchdog: no heartbeat within timeout period')
      RETURNING id
    `;
    await processQaResult(sql, qa.id, { passed: true, feedback: null });

    const [supervisor] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${biz.id}, 'test-completed-failure-role', 'owner', 'Supervisor completion', 'brief', 'active', 'Doctor intervened after turn limit')
      RETURNING id
    `;
    await applySupervisorActions(sql, biz.id, {
      summary: "close completed rows cleanly",
      findings_addressed: [],
      actions: [{ kind: "close_task", taskId: supervisor.id, note: "close it out" }],
    });

    const [row] = await sql<{ bad_completed_rows: number }[]>`
      SELECT COUNT(*)::int AS bad_completed_rows
      FROM tasks
      WHERE hive_id = ${biz.id}
        AND status = 'completed'
        AND failure_reason IS NOT NULL
    `;
    expect(row.bad_completed_rows).toBe(0);
  });
});
