import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  handleTaskFailure,
  handleTaskFailureAndDoctor,
  FailureCategory,
  isRuntimeCrash,
} from "@/dispatcher/failure-handler";
import { DEFAULT_CONFIG } from "@/dispatcher/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import * as sender from "../../src/notifications/sender";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('fail-test-biz', 'Fail Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('fail-test-role', 'FT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});


describe("handleTaskFailure", () => {
  it("classifies runtime crashes separately from doctor verdicts", () => {
    expect(isRuntimeCrash("Codex exited code 1: codex reported error")).toBe(true);
    expect(isRuntimeCrash("Spawn failed: ENOENT")).toBe(true);
    expect(isRuntimeCrash("Process killed by watchdog")).toBe(true);
    expect(isRuntimeCrash("Doctor verdict: task is out of scope")).toBe(false);
  });

  it("retries spawn failures by releasing to pending", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count)
      VALUES (${bizId}, 'fail-test-role', 'owner', 'fail-test-spawn', 'Brief', 'active', 0)
      RETURNING *
    `;

    const result = await handleTaskFailure(sql, task.id, FailureCategory.SpawnFailure, "API down", DEFAULT_CONFIG);
    expect(result).toBe("retried");

    const [updated] = await sql`SELECT status, retry_count FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.retry_count).toBe(1);
  });

  it("bounds provider-outage retry backoff at 60s, 300s, then 900s", async () => {
    for (const [retryCount, expectedSeconds] of [[0, 60], [1, 300], [2, 900]] as const) {
      const [task] = await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count)
        VALUES (${bizId}, 'fail-test-role', 'owner', ${`fail-test-backoff-${retryCount}`}, 'Brief', 'active', ${retryCount})
        RETURNING *
      `;

      const result = await handleTaskFailure(
        sql,
        task.id,
        FailureCategory.SpawnFailure,
        "Claude provider outage drill",
        DEFAULT_CONFIG,
      );
      expect(result).toBe("retried");

      const [updated] = await sql`
        SELECT
          status,
          retry_count,
          EXTRACT(EPOCH FROM (retry_after - NOW()))::int AS delay_seconds
        FROM tasks
        WHERE id = ${task.id}
      `;
      expect(updated.status).toBe("pending");
      expect(updated.retry_count).toBe(retryCount + 1);
      expect(Number(updated.delay_seconds)).toBeGreaterThanOrEqual(expectedSeconds - 5);
      expect(Number(updated.delay_seconds)).toBeLessThanOrEqual(expectedSeconds + 5);
    }
  });

  it("marks spawn failures as unresolvable after max retries (not doctor)", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count)
      VALUES (${bizId}, 'fail-test-role', 'owner', 'fail-test-maxretry', 'Brief', 'active', 3)
      RETURNING *
    `;

    const result = await handleTaskFailure(sql, task.id, FailureCategory.SpawnFailure, "Still down", DEFAULT_CONFIG);
    expect(result).toBe("unresolvable");

    const [updated] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");
  });

  it("sends agent-reported failures directly to doctor", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count)
      VALUES (${bizId}, 'fail-test-role', 'owner', 'fail-test-agent', 'Brief', 'active', 0)
      RETURNING *
    `;

    const result = await handleTaskFailure(sql, task.id, FailureCategory.AgentReported, "Cannot do this", DEFAULT_CONFIG);
    expect(result).toBe("doctor");
  });

  it("parks a task family instead of creating another doctor task after recovery budget is exhausted", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'ollama')
      ON CONFLICT (slug) DO NOTHING
    `;

    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count)
      VALUES (${bizId}, 'fail-test-role', 'owner', 'fail-test-budget', 'Brief', 'active', 0)
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES
        (${bizId}, 'doctor', 'dispatcher', '[Doctor] first budget task', 'diagnose', 'unresolvable', ${task.id}),
        (${bizId}, 'doctor', 'dispatcher', '[Doctor] fallback budget task', 'diagnose', 'failed', ${task.id})
    `;

    const result = await handleTaskFailureAndDoctor(
      sql,
      task.id,
      FailureCategory.AgentReported,
      "Still cannot complete this task",
      DEFAULT_CONFIG,
    );

    expect(result).toBe("unresolvable");

    const doctorTasks = await sql`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${task.id}
        AND assigned_to = 'doctor'
    `;
    expect(doctorTasks).toHaveLength(2);

    const [updated] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toContain("Recovery budget exhausted");
  });

  it("parks a task family instead of creating doctor work when a recovery decision is already open", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'ollama')
      ON CONFLICT (slug) DO NOTHING
    `;

    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count)
      VALUES (${bizId}, 'fail-test-role', 'owner', 'fail-test-open-decision', 'Brief', 'active', 0)
      RETURNING *
    `;

    await sql`
      INSERT INTO decisions (hive_id, task_id, title, context, recommendation, priority, status, kind)
      VALUES (
        ${bizId},
        ${task.id},
        'Existing recovery decision',
        'The same failure family is already waiting for review.',
        'Do not spawn more recovery work.',
        'urgent',
        'ea_review',
        'system_error'
      )
    `;

    const result = await handleTaskFailureAndDoctor(
      sql,
      task.id,
      FailureCategory.AgentReported,
      "Still blocked while decision is open",
      DEFAULT_CONFIG,
    );

    expect(result).toBe("unresolvable");

    const doctorTasks = await sql`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${task.id}
        AND assigned_to = 'doctor'
    `;
    expect(doctorTasks).toHaveLength(0);

    const [updated] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toContain("Open recovery decisions: 1/1");
  });

  it("marks as unresolvable after max doctor attempts", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count, doctor_attempts)
      VALUES (${bizId}, 'fail-test-role', 'owner', 'fail-test-unresolvable', 'Brief', 'active', 3, 2)
      RETURNING *
    `;

    const result = await handleTaskFailure(sql, task.id, FailureCategory.SpawnFailure, "Still failing", DEFAULT_CONFIG);
    expect(result).toBe("unresolvable");

    const [updated] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");
  });

  it("recursion guard: a failed doctor task is marked unresolvable, never spawns another doctor", async () => {
    // Seed the doctor role template (test DB doesn't have role-library synced).
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'ollama')
      ON CONFLICT (slug) DO NOTHING
    `;

    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count, doctor_attempts)
      VALUES (${bizId}, 'doctor', 'system', 'fail-test-doctor-recursion', 'Diagnose something', 'active', 0, 0)
      RETURNING *
    `;

    // Even an agent-reported failure (which would normally → "doctor") must
    // resolve to "unresolvable" when the failing task is itself a doctor.
    const result = await handleTaskFailure(
      sql,
      task.id,
      FailureCategory.AgentReported,
      "Doctor adapter blew up",
      DEFAULT_CONFIG,
    );
    expect(result).toBe("unresolvable");

    const [updated] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toBe("Doctor adapter blew up");
  });
});

describe("doctor runtime fallback", () => {
  it("creates an auto-routed doctor retry when a doctor task crashes on its runtime", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'codex'),
             ('runtime-parent-role', 'Runtime Parent', 'executor', 'claude-code')
      ON CONFLICT (slug) DO UPDATE SET adapter_type = EXCLUDED.adapter_type
    `;

    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'runtime-parent-role', 'owner', 'runtime parent', 'do work', 'failed')
      RETURNING *
    `;
    const [doctorTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${bizId}, 'doctor', 'dispatcher', '[Doctor] Diagnose: runtime parent', 'diagnose', 'active', ${parent.id})
      RETURNING *
    `;
    await sql`
      INSERT INTO task_workspaces (
        task_id, base_workspace_path, worktree_path, branch_name,
        isolation_status, isolation_active, reused
      )
      VALUES (
        ${doctorTask.id}, '/repo/base', '/repo/base/.claude/worktrees/doctor',
        'hw/task/doctor', 'active', true, false
      )
    `;

    const result = await handleTaskFailure(
      sql,
      doctorTask.id,
      FailureCategory.AgentReported,
      "Codex exited code 1: codex reported error",
      DEFAULT_CONFIG,
    );

    expect(result).toBe("retried");

    const [original] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${doctorTask.id}`;
    expect(original.status).toBe("unresolvable");
    expect(original.failure_reason).toContain("Codex exited code 1");

    const retries = await sql`
      SELECT adapter_override, model_override, parent_task_id, status
      FROM tasks
      WHERE parent_task_id = ${parent.id}
        AND assigned_to = 'doctor'
        AND adapter_override = 'auto'
    `;
    expect(retries).toHaveLength(1);
    expect(retries[0].model_override).toBe("auto");
    expect(retries[0].status).toBe("pending");

    const [workspace] = await sql`
      SELECT worktree_path, branch_name, reused
      FROM task_workspaces
      WHERE task_id = (
        SELECT id FROM tasks
        WHERE parent_task_id = ${parent.id}
          AND assigned_to = 'doctor'
          AND adapter_override = 'auto'
      )
    `;
    expect(workspace.worktree_path).toBe("/repo/base/.claude/worktrees/doctor");
    expect(workspace.branch_name).toBe("hw/task/doctor");
    expect(workspace.reused).toBe(true);
  });

  it("creates a Tier 3 decision when the auto-routed doctor retry also crashes", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'codex'),
             ('runtime-parent-role-2', 'Runtime Parent 2', 'executor', 'claude-code')
      ON CONFLICT (slug) DO UPDATE SET adapter_type = EXCLUDED.adapter_type
    `;

    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'runtime-parent-role-2', 'owner', 'runtime parent 2', 'do work', 'failed')
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, failure_reason)
      VALUES (${bizId}, 'doctor', 'dispatcher', '[Doctor] Diagnose: runtime parent 2', 'diagnose', 'unresolvable', ${parent.id}, 'Codex exited code 1: codex reported error')
    `;
    const [retry] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, adapter_override, model_override)
      VALUES (${bizId}, 'doctor', 'dispatcher', '[Doctor retry: auto] runtime parent 2', 'diagnose', 'active', ${parent.id}, 'auto', 'auto')
      RETURNING *
    `;

    const result = await handleTaskFailure(
      sql,
      retry.id,
      FailureCategory.AgentReported,
      "Spawn error: auto-routed runtime failed",
      DEFAULT_CONFIG,
    );

    expect(result).toBe("unresolvable");

    const [updatedRetry] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${retry.id}`;
    expect(updatedRetry.status).toBe("unresolvable");
    expect(updatedRetry.failure_reason).toBe("Spawn error: auto-routed runtime failed");

    const decisions = await sql`
      SELECT title, context, priority, status, kind
      FROM decisions
      WHERE task_id = ${parent.id}
    `;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].title).toContain("Doctor runtime fallback failed");
    expect(decisions[0].context).toContain("Codex exited code 1");
    expect(decisions[0].context).toContain("Spawn error: auto-routed runtime failed");
    expect(decisions[0].priority).toBe("urgent");
    expect(decisions[0].status).toBe("ea_review");
    expect(decisions[0].kind).toBe("system_error");
  });

  it("does not create a fallback retry for a non-runtime doctor verdict", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'codex'),
             ('runtime-parent-role-3', 'Runtime Parent 3', 'executor', 'claude-code')
      ON CONFLICT (slug) DO UPDATE SET adapter_type = EXCLUDED.adapter_type
    `;

    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'runtime-parent-role-3', 'owner', 'runtime parent 3', 'do work', 'failed')
      RETURNING *
    `;
    const [doctorTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${bizId}, 'doctor', 'dispatcher', '[Doctor] Diagnose: runtime parent 3', 'diagnose', 'active', ${parent.id})
      RETURNING *
    `;

    const result = await handleTaskFailure(
      sql,
      doctorTask.id,
      FailureCategory.AgentReported,
      "Doctor verdict: escalate to owner",
      DEFAULT_CONFIG,
    );

    expect(result).toBe("unresolvable");

    const retries = await sql`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${parent.id}
        AND assigned_to = 'doctor'
        AND adapter_override = 'auto'
    `;
    expect(retries).toHaveLength(0);
  });
});

describe("recursion guard escalates to Tier 3 decision", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates an ea_review decision when a doctor task fails (no inline notification)", async () => {
    // EA-first pipeline: escalateRecursionGuard no longer fires
    // sendPushNotification / sendNotification inline. The owner ping is
    // fired by the EA after it decides to escalate. Verify the spy stays
    // untouched here so we don't regress to inline pings.
    const pushSpy = vi.spyOn(sender, "sendPushNotification").mockResolvedValue(undefined);
    const notifySpy = vi.spyOn(sender, "sendNotification").mockResolvedValue({ sent: 0, errors: 0, skipped: 0 });

    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'ollama'),
             ('research-analyst', 'Research Analyst', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;

    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('tier3-test', 'Tier3 Test', 'digital')
      RETURNING *
    `;

    const [parent] = await sql`
      INSERT INTO tasks (hive_id, title, brief, assigned_to, created_by, status)
      VALUES (${biz.id}, 'research report', 'write the report', 'research-analyst', 'owner', 'pending')
      RETURNING *
    `;

    const [doctorTask] = await sql`
      INSERT INTO tasks (hive_id, title, brief, assigned_to, created_by, status, parent_task_id, retry_count, doctor_attempts)
      VALUES (${biz.id}, 'doctor task', 'diagnose parent', 'doctor', 'system', 'active', ${parent.id}, 0, 0)
      RETURNING *
    `;

    const result = await handleTaskFailure(
      sql,
      doctorTask.id,
      FailureCategory.AgentReported,
      "sample failure",
      DEFAULT_CONFIG,
    );

    expect(result).toBe("unresolvable");

    const decisions = await sql`SELECT * FROM decisions WHERE task_id = ${parent.id}`;
    expect(decisions).toHaveLength(1);
    const d = decisions[0] as {
      priority: string;
      title: string;
      status: string;
      options: Array<{ label: string; action: string }>;
    };
    expect(d.priority).toBe("urgent");
    expect(d.status).toBe("ea_review");
    expect(d.title).toContain("research report");
    const actions = d.options.map((o) => o.action);
    expect(actions).toEqual(expect.arrayContaining(["retry", "reassign", "drop"]));

    expect(pushSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("standalone doctor task (no parent) marked unresolvable with ea_review decision", async () => {
    // Same EA-first behaviour: no inline notifications; the EA fires
    // them after deciding the case warrants owner attention.
    const pushSpy = vi.spyOn(sender, "sendPushNotification").mockResolvedValue(undefined);
    const notifySpy = vi.spyOn(sender, "sendNotification").mockResolvedValue({ sent: 0, errors: 0, skipped: 0 });

    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('doctor', 'Doctor', 'system', 'ollama')
      ON CONFLICT (slug) DO NOTHING
    `;

    const [biz] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES ('standalone-doctor-test', 'Standalone Doctor Test', 'digital')
      RETURNING *
    `;

    const [doctorTask] = await sql`
      INSERT INTO tasks (hive_id, title, brief, assigned_to, created_by, status, parent_task_id, retry_count, doctor_attempts)
      VALUES (${biz.id}, 'standalone doctor task', 'self-healing attempt', 'doctor', 'system', 'active', NULL, 0, 0)
      RETURNING *
    `;

    const result = await handleTaskFailure(
      sql,
      doctorTask.id,
      FailureCategory.AgentReported,
      "no-parent failure",
      DEFAULT_CONFIG,
    );

    expect(result).toBe("unresolvable");

    const [updated] = await sql`SELECT status FROM tasks WHERE id = ${doctorTask.id}`;
    expect(updated.status).toBe("unresolvable");

    const decisions = await sql`SELECT * FROM decisions WHERE hive_id = ${biz.id}`;
    expect(decisions).toHaveLength(1);
    const d = decisions[0] as {
      task_id: string | null;
      priority: string;
      title: string;
      status: string;
    };
    expect(d.task_id).toBeNull();
    expect(d.priority).toBe("urgent");
    expect(d.status).toBe("ea_review");
    expect(d.title).toContain("(unknown task)");

    expect(pushSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
