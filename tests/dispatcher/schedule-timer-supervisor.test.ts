import { describe, it, expect, beforeEach } from "vitest";
import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";
import { testSql as sql, truncateAll } from "../_lib/test-db";

/**
 * Heartbeat-path integration tests: a schedules row whose task_template
 * carries `kind: 'hive-supervisor-heartbeat'` must short-circuit to
 * runSupervisor instead of inserting a normal task. These tests exercise
 * the full code path (schedule-timer → runSupervisor → scan → persist)
 * against the real test DB — the only thing they don't cover is agent
 * invocation itself (runSupervisor's default falls back to spawning a
 * task with empty output, which these tests assert against).
 */

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('hive-supervisor', 'Hive Supervisor', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [biz] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('sched-sup-test', 'Schedule Supervisor Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id;
});

describe("checkAndFireSchedules — hive-supervisor-heartbeat", () => {
  it("short-circuits to runSupervisor and does NOT enqueue a normal task when findings are empty", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hiveId},
        '*/15 * * * *',
        ${sql.json({
          kind: "hive-supervisor-heartbeat",
          assignedTo: "hive-supervisor",
          title: "Hive supervisor heartbeat",
          brief: "(populated at run time)",
        })},
        true,
        NOW() - interval '1 minute',
        'test'
      )
    `;

    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    // No "Hive supervisor heartbeat" placeholder task should have been
    // created — the heartbeat short-circuits the normal INSERT path.
    const placeholderTasks = await sql`
      SELECT id FROM tasks WHERE title = 'Hive supervisor heartbeat'
    `;
    expect(placeholderTasks).toHaveLength(0);

    // Clean hive → no supervisor_reports row either (short-circuit on
    // empty findings).
    const reports = await sql`SELECT id FROM supervisor_reports WHERE hive_id = ${hiveId}`;
    expect(reports).toHaveLength(0);

    // The schedule must still advance — last_run_at set, next_run_at in
    // the future. Otherwise a stuck heartbeat would refire every tick.
    const [after] = await sql<{ last_run_at: Date; next_run_at: Date }[]>`
      SELECT last_run_at, next_run_at FROM schedules WHERE hive_id = ${hiveId}
    `;
    expect(after.last_run_at).not.toBeNull();
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("invokes runSupervisor which persists a report row when findings are present", async () => {
    // Seed an aging_decision finding.
    await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status, created_at)
      VALUES (
        ${hiveId},
        'aging decision',
        'context',
        'normal',
        'pending',
        NOW() - interval '48 hours'
      )
    `;

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hiveId},
        '*/15 * * * *',
        ${sql.json({
          kind: "hive-supervisor-heartbeat",
          assignedTo: "hive-supervisor",
          title: "Hive supervisor heartbeat",
          brief: "(populated at run time)",
        })},
        true,
        NOW() - interval '1 minute',
        'test'
      )
    `;

    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    // supervisor_reports row persisted — the scan produced findings, so
    // runSupervisor wrote the audit row and invoked the default agent
    // (which enqueues a hive-supervisor task).
    const reports = await sql<{ id: string; agent_task_id: string | null }[]>`
      SELECT id, agent_task_id FROM supervisor_reports WHERE hive_id = ${hiveId}
    `;
    expect(reports).toHaveLength(1);
    expect(reports[0].agent_task_id).not.toBeNull();

    // A single hive-supervisor task exists (the deferred agent run),
    // created_by='dispatcher'. The scheduler itself did NOT insert any
    // other task (no placeholder for the heartbeat template).
    const supTasks = await sql<{ title: string; created_by: string }[]>`
      SELECT title, created_by FROM tasks WHERE assigned_to = 'hive-supervisor'
    `;
    expect(supTasks).toHaveLength(1);
    expect(supTasks[0].created_by).toBe("dispatcher");
  });

  it("continues to enqueue normal tasks for non-heartbeat schedules", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hiveId},
        '0 8 * * 1',
        ${sql.json({
          assignedTo: "dev-agent",
          title: "regular weekly task",
          brief: "Do the weekly thing",
        })},
        true,
        NOW() - interval '1 minute',
        'test'
      )
    `;

    await checkAndFireSchedules(sql);

    const [task] = await sql<{ assigned_to: string }[]>`
      SELECT assigned_to FROM tasks WHERE title = 'regular weekly task'
    `;
    expect(task.assigned_to).toBe("dev-agent");
  });
});
