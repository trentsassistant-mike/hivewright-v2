import { describe, it, expect, beforeEach } from "vitest";
import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('sched-test-biz', 'Schedule Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('sched-test-role', 'ST Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});


describe("checkAndFireSchedules", () => {
  it("creates a task when schedule is due", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${bizId},
        '0 8 * * 1',
        ${JSON.stringify({ assignedTo: "sched-test-role", title: "sched-test-weekly", brief: "Do weekly thing", qaRequired: false })}::jsonb,
        true,
        NOW() - INTERVAL '1 minute',
        'test'
      )
    `;

    const created = await checkAndFireSchedules(sql);
    expect(created).toBeGreaterThanOrEqual(1);

    const tasks = await sql`SELECT * FROM tasks WHERE title = 'sched-test-weekly'`;
    expect(tasks.length).toBe(1);
    expect(tasks[0].assigned_to).toBe("sched-test-role");
  });

  it("does not fire disabled schedules", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${bizId},
        '0 8 * * 1',
        ${JSON.stringify({ assignedTo: "sched-test-role", title: "sched-test-disabled", brief: "Should not fire" })}::jsonb,
        false,
        NOW() - INTERVAL '1 minute',
        'test'
      )
    `;

    await checkAndFireSchedules(sql);

    const tasks = await sql`SELECT * FROM tasks WHERE title = 'sched-test-disabled'`;
    expect(tasks.length).toBe(0);
  });

  it("does not fire schedules with future next_run_at", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${bizId},
        '0 8 * * 1',
        ${JSON.stringify({ assignedTo: "sched-test-role", title: "sched-test-future", brief: "Not yet" })}::jsonb,
        true,
        NOW() + INTERVAL '1 hour',
        'test'
      )
    `;

    await checkAndFireSchedules(sql);

    const tasks = await sql`SELECT * FROM tasks WHERE title = 'sched-test-future'`;
    expect(tasks.length).toBe(0);
  });

  it("persists an explicit task_template.projectId on scheduled tasks", async () => {
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${bizId}, 'explicit-project-camel', 'Explicit Project', '/tmp/schedule-explicit-camel')
      RETURNING id
    `;

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${bizId},
        '0 8 * * 1',
        ${JSON.stringify({
          assignedTo: "sched-test-role",
          title: "sched-test-explicit-project-camel",
          brief: "Use the explicit project",
          projectId: project.id,
        })}::jsonb,
        true,
        NOW() - INTERVAL '1 minute',
        'test'
      )
    `;

    await checkAndFireSchedules(sql);

    const [task] = await sql<{ project_id: string | null }[]>`
      SELECT project_id FROM tasks WHERE title = 'sched-test-explicit-project-camel'
    `;
    expect(task.project_id).toBe(project.id);
  });

  it("persists an explicit task_template.project_id on scheduled tasks", async () => {
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${bizId}, 'explicit-project-snake', 'Explicit Project', '/tmp/schedule-explicit-snake')
      RETURNING id
    `;

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${bizId},
        '0 8 * * 1',
        ${JSON.stringify({
          assignedTo: "sched-test-role",
          title: "sched-test-explicit-project-snake",
          brief: "Use the explicit project",
          project_id: project.id,
        })}::jsonb,
        true,
        NOW() - INTERVAL '1 minute',
        'test'
      )
    `;

    await checkAndFireSchedules(sql);

    const [task] = await sql<{ project_id: string | null }[]>`
      SELECT project_id FROM tasks WHERE title = 'sched-test-explicit-project-snake'
    `;
    expect(task.project_id).toBe(project.id);
  });

  it("uses the hive's single project as the scheduled task default project", async () => {
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${bizId}, 'only-project', 'Only Project', '/tmp/schedule-only-project')
      RETURNING id
    `;

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${bizId},
        '0 8 * * 1',
        ${JSON.stringify({
          assignedTo: "sched-test-role",
          title: "sched-test-single-project-default",
          brief: "Use the only project for scheduled work",
        })}::jsonb,
        true,
        NOW() - INTERVAL '1 minute',
        'test'
      )
    `;

    await checkAndFireSchedules(sql);

    const [task] = await sql<{ project_id: string | null }[]>`
      SELECT project_id FROM tasks WHERE title = 'sched-test-single-project-default'
    `;
    expect(task.project_id).toBe(project.id);
  });

  it("leaves project_id empty for scheduled tasks when a hive has multiple projects and no explicit project", async () => {
    await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES
        (${bizId}, 'project-a', 'Project A', '/tmp/schedule-project-a'),
        (${bizId}, 'project-b', 'Project B', '/tmp/schedule-project-b')
    `;

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${bizId},
        '0 8 * * 1',
        ${JSON.stringify({
          assignedTo: "sched-test-role",
          title: "sched-test-ambiguous-project-default",
          brief: "Stay in the hive workspace when the project default is ambiguous",
        })}::jsonb,
        true,
        NOW() - INTERVAL '1 minute',
        'test'
      )
    `;

    await checkAndFireSchedules(sql);

    const [task] = await sql<{ project_id: string | null }[]>`
      SELECT project_id FROM tasks WHERE title = 'sched-test-ambiguous-project-default'
    `;
    expect(task.project_id).toBeNull();
  });
});
