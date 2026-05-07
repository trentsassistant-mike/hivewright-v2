import { describe, it, expect, beforeEach } from "vitest";
import { claimNextTask, completeTask, releaseTask } from "@/dispatcher/task-claimer";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('claimer-test-biz', 'Claimer Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('claimer-test-role', 'CT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("claimNextTask", () => {
  it("claims a pending task atomically", async () => {
    // Insert with future retry_after so the live dispatcher skips it
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-1', 'Do it', 5, NOW() + INTERVAL '1 hour')
    `;
    // Clear retry_after and immediately claim — dispatcher won't be notified of the update
    await sql`UPDATE tasks SET retry_after = NULL WHERE title = 'claimer-test-1' AND status = 'pending'`;

    const task = await claimNextTask(sql, process.pid);
    expect(task).not.toBeNull();
    expect(task!.title).toBe("claimer-test-1");
    expect(task!.status).toBe("active");
  });

  it("returns null when no pending tasks", async () => {
    // No test tasks inserted, so only stray tasks from the dispatcher could be pending.
    // Insert and immediately claim a canary to flush the queue state, then verify null.
    const task = await claimNextTask(sql, process.pid);
    // If dispatcher left a stray pending task, we might get it — that's OK,
    // re-check after clearing to verify the "no pending" path:
    if (task) {
      await sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${task.id}`;
    }
    const task2 = await claimNextTask(sql, process.pid);
    expect(task2).toBeNull();
  });

  it("claims highest priority first (lowest number)", async () => {
    // Insert with future retry_after so the live dispatcher skips them
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, retry_after)
      VALUES
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-low', 'Low', 10, NOW() + INTERVAL '1 hour'),
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-high', 'High', 1, NOW() + INTERVAL '1 hour')
    `;
    // Clear retry_after on both and immediately claim
    await sql`UPDATE tasks SET retry_after = NULL WHERE title LIKE 'claimer-test-%' AND status = 'pending'`;

    const task = await claimNextTask(sql, process.pid);
    expect(task!.title).toBe("claimer-test-high");
  });

  it("does not claim a second task for a role that already has an active task", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-busy-active', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-blocked-by-busy', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    if (task) {
      expect(task.title).not.toBe("claimer-test-blocked-by-busy");
    }
  });

  it("does claim a second task for a different role", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('claimer-test-role-other', 'CT Other', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-busy-active-2', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role-other', 'owner', 'claimer-test-other-role', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task?.title).toBe("claimer-test-other-role");
  });

  it("allows a second goal-supervisor task even when one is active", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, concurrency_limit)
      VALUES ('goal-supervisor', 'Supervisor', 'system', 'claude-code', 50)
      ON CONFLICT (slug) DO UPDATE SET concurrency_limit = 50
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'goal-supervisor', 'dispatcher', 'sup-active', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'goal-supervisor', 'dispatcher', 'sup-pending-allowed', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task?.title).toBe("sup-pending-allowed");
  });

  it("skips tasks with future retry_after", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-retry', 'Retry later', NOW() + INTERVAL '1 hour')
    `;

    const task = await claimNextTask(sql, process.pid);
    // The task has retry_after in the future, so it should be skipped.
    // If a stray non-test task gets claimed, that's OK — we just need to verify
    // our test task was NOT the one claimed.
    if (task) {
      expect(task.title).not.toBe("claimer-test-retry");
    }
  });
});

describe("releaseTask", () => {
  it("sets task back to pending with retry_after and increments retry_count", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-release', 'Brief', 'active')
      RETURNING *
    `;

    await releaseTask(sql, inserted.id, 60);

    const [updated] = await sql`SELECT status, retry_count, retry_after FROM tasks WHERE id = ${inserted.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.retry_count).toBe(1);
    expect(updated.retry_after).not.toBeNull();
  });
});

describe("completeTask", () => {
  it("marks the task completed and clears stale failure_reason", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-complete', 'Brief', 'active', 'Reached maximum turn limit')
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Recovered after retry");

    const [updated] = await sql`
      SELECT status, result_summary, failure_reason, completed_at
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.result_summary).toBe("Recovered after retry");
    expect(updated.failure_reason).toBeNull();
    expect(updated.completed_at).not.toBeNull();
  });

  it("marks the task completed and preserves explicit runtime warnings", async () => {
    const warning = "Codex rollout registration failed after agent output was captured; HiveWright persisted stdout directly.";
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-complete-warning', 'Brief', 'active', 'Reached maximum turn limit')
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Recovered after retry", { runtimeWarnings: [warning] });

    const [updated] = await sql`
      SELECT status, result_summary, failure_reason, completed_at
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.result_summary).toBe("Recovered after retry");
    expect(updated.failure_reason).toBe(warning);
    expect(updated.completed_at).not.toBeNull();
  });
});
