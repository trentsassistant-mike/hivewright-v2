import { describe, it, expect, beforeEach } from "vitest";
import {
  findNewGoals,
  findCompletedSprintsForWakeUp,
  markSprintWakeUpSent,
  claimSprintWakeUp,
  revertSprintWakeUp,
  findOrphanedWakeUps,
  findSupervisorWakeReconciliationCandidates,
  acquireGoalSupervisorWakeLock,
} from "@/dispatcher/goal-lifecycle";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('glc-test-biz', 'GLC Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('glc-test-role', 'GLC Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("findNewGoals", () => {
  it("finds active goals with no session_id", async () => {
    await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-new', 'active', NULL)
    `;

    const newGoals = await findNewGoals(sql);
    expect(newGoals.some((g) => g.title === "glc-test-new")).toBe(true);
  });

  it("ignores goals that already have a session", async () => {
    await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-has-session', 'active', 'gs-existing')
    `;

    const newGoals = await findNewGoals(sql);
    expect(newGoals.some((g) => g.title === "glc-test-has-session")).toBe(false);
  });

  it("ignores non-active goals", async () => {
    await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-achieved', 'achieved', NULL)
    `;

    const newGoals = await findNewGoals(sql);
    expect(newGoals.some((g) => g.title === "glc-test-achieved")).toBe(false);
  });
});

describe("findCompletedSprintsForWakeUp", () => {
  it("finds sprints that are complete for active goals with sessions", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-sprint', 'active', 'gs-sprint-test')
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s1t1', 'B', ${goal.id}, 1, 'completed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s1t2', 'B', ${goal.id}, 1, 'completed')
    `;

    const completed = await findCompletedSprintsForWakeUp(sql);
    expect(completed.some((c) => c.goalId === goal.id && c.sprintNumber === 1)).toBe(true);
  });

  it("ignores sprints with incomplete tasks", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-incomplete', 'active', 'gs-incomplete')
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s2t1', 'B', ${goal.id}, 1, 'completed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s2t2', 'B', ${goal.id}, 1, 'active')
    `;

    const completed = await findCompletedSprintsForWakeUp(sql);
    expect(completed.some((c) => c.goalId === goal.id)).toBe(false);
  });

  it("detects sprints where all tasks settled but some failed", async () => {
    // Previously this was filtered out by failed_count = 0.
    // The supervisor must be woken even when tasks fail so it can handle them.
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-with-failures', 'active', 'gs-failures')
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s3t1', 'B', ${goal.id}, 1, 'completed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s3t2', 'B', ${goal.id}, 1, 'failed')
    `;

    const completed = await findCompletedSprintsForWakeUp(sql);
    expect(completed.some((c) => c.goalId === goal.id && c.sprintNumber === 1)).toBe(true);
  });

  it("does not re-trigger wake-up after markSprintWakeUpSent", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-dedup', 'active', 'gs-dedup')
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s4t1', 'B', ${goal.id}, 1, 'completed')
    `;

    // Before marking: should appear
    const before = await findCompletedSprintsForWakeUp(sql);
    expect(before.some((c) => c.goalId === goal.id && c.sprintNumber === 1)).toBe(true);

    await markSprintWakeUpSent(sql, goal.id as string, 1);

    // After marking: should not appear again
    const after = await findCompletedSprintsForWakeUp(sql);
    expect(after.some((c) => c.goalId === goal.id && c.sprintNumber === 1)).toBe(false);
  });

  it("does not re-trigger for lower sprints after a higher one is woken", async () => {
    // markSprintWakeUpSent uses GREATEST so marking sprint 2 also suppresses sprint 1
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-greatest', 'active', 'gs-greatest')
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s5t1', 'B', ${goal.id}, 1, 'completed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-s5t2', 'B', ${goal.id}, 2, 'completed')
    `;

    await markSprintWakeUpSent(sql, goal.id as string, 2);

    const after = await findCompletedSprintsForWakeUp(sql);
    expect(after.some((c) => c.goalId === goal.id)).toBe(false);
  });

  it("surfaces sprint with only cancelled tasks (cancellations must not be treated as completion)", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-all-cancelled', 'active', 'gs-all-cancelled')
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-c1', 'b', ${goal.id}, 1, 'cancelled'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-c2', 'b', ${goal.id}, 1, 'cancelled')
    `;

    const completed = await findCompletedSprintsForWakeUp(sql);
    const match = completed.find((c) => c.goalId === goal.id);
    expect(match).toBeDefined();
    expect(match!.completedCount).toBe(0);
    expect(match!.cancelledCount).toBe(2);
    expect(match!.failedCount).toBe(0);
  });

  it("returns explicit completed/failed/cancelled counts in mixed sprint", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-mixed', 'active', 'gs-mixed')
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-m1', 'b', ${goal.id}, 1, 'completed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-m2', 'b', ${goal.id}, 1, 'completed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-m3', 'b', ${goal.id}, 1, 'failed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-m4', 'b', ${goal.id}, 1, 'cancelled')
    `;

    const completed = await findCompletedSprintsForWakeUp(sql);
    const match = completed.find((c) => c.goalId === goal.id);
    expect(match).toBeDefined();
    expect(match!.completedCount).toBe(2);
    expect(match!.failedCount).toBe(1);
    expect(match!.cancelledCount).toBe(1);
  });
});

describe("claimSprintWakeUp", () => {
  it("allows only one caller to claim a completed sprint wake", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-atomic-claim', 'active', 'gs-atomic-claim')
      RETURNING *
    `;

    const [first, second] = await Promise.all([
      claimSprintWakeUp(sql, goal.id as string, 2),
      claimSprintWakeUp(sql, goal.id as string, 2),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const [row] = await sql`SELECT last_woken_sprint FROM goals WHERE id = ${goal.id}`;
    expect(row.last_woken_sprint).toBe(2);
  });

  it("does not claim an older sprint after a newer sprint has already been marked", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint)
      VALUES (${bizId}, 'glc-test-atomic-old', 'active', 'gs-atomic-old', 3)
      RETURNING *
    `;

    await expect(claimSprintWakeUp(sql, goal.id as string, 2)).resolves.toBe(false);

    const [row] = await sql`SELECT last_woken_sprint FROM goals WHERE id = ${goal.id}`;
    expect(row.last_woken_sprint).toBe(3);
  });
});

describe("acquireGoalSupervisorWakeLock", () => {
  it("excludes concurrent supervisor wakes for the same goal", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-wake-lock', 'active', 'gs-wake-lock')
      RETURNING *
    `;

    const first = await acquireGoalSupervisorWakeLock(sql, goal.id as string);
    expect(first).not.toBeNull();

    const second = await acquireGoalSupervisorWakeLock(sql, goal.id as string);
    expect(second).toBeNull();

    await first!();
    const third = await acquireGoalSupervisorWakeLock(sql, goal.id as string);
    expect(third).not.toBeNull();
    await third!();
  });

  it("allows simultaneous supervisor wakes for different goals", async () => {
    const [firstGoal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-wake-lock-a', 'active', 'gs-wake-lock-a')
      RETURNING *
    `;
    const [secondGoal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-wake-lock-b', 'active', 'gs-wake-lock-b')
      RETURNING *
    `;

    const first = await acquireGoalSupervisorWakeLock(sql, firstGoal.id as string);
    const second = await acquireGoalSupervisorWakeLock(sql, secondGoal.id as string);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await first!();
    await second!();
  });
});

describe("revertSprintWakeUp", () => {
  it("rolls last_woken_sprint back so the next poll re-detects the sprint", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-revert', 'active', 'gs-revert')
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-rv1', 'b', ${goal.id}, 1, 'completed')
    `;

    await markSprintWakeUpSent(sql, goal.id as string, 1);
    let after = await findCompletedSprintsForWakeUp(sql);
    expect(after.some((c) => c.goalId === goal.id)).toBe(false);

    await revertSprintWakeUp(sql, goal.id as string, 1);
    after = await findCompletedSprintsForWakeUp(sql);
    expect(after.some((c) => c.goalId === goal.id && c.sprintNumber === 1)).toBe(true);
  });

  it("does not clobber a higher-sprint marker that landed concurrently", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${bizId}, 'glc-test-revert-no-clobber', 'active', 'gs-noclobber')
      RETURNING *
    `;

    // A later sprint already marked as woken
    await markSprintWakeUpSent(sql, goal.id as string, 3);

    // A failing sprint-1 wake tries to revert. Guard should prevent rollback
    // because last_woken_sprint = 3, not 1.
    await revertSprintWakeUp(sql, goal.id as string, 1);

    const [row] = await sql`SELECT last_woken_sprint FROM goals WHERE id = ${goal.id}`;
    expect(row.last_woken_sprint).toBe(3);
  });
});

describe("findOrphanedWakeUps", () => {
  it("finds goals where last_woken_sprint matches max sprint, no open tasks, and update is stale", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint, updated_at)
      VALUES (${bizId}, 'glc-test-orphan', 'active', 'gs-orphan', 1, NOW() - INTERVAL '15 minutes')
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-orph1', 'b', ${goal.id}, 1, 'completed')
    `;

    const orphans = await findOrphanedWakeUps(sql);
    const match = orphans.find((o) => o.goalId === goal.id);
    expect(match).toBeDefined();
    expect(match!.sprintNumber).toBe(1);
  });

  it("ignores fresh wake-ups (still within the in-flight window)", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint, updated_at)
      VALUES (${bizId}, 'glc-test-fresh', 'active', 'gs-fresh', 1, NOW())
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-fresh1', 'b', ${goal.id}, 1, 'completed')
    `;

    const orphans = await findOrphanedWakeUps(sql);
    expect(orphans.some((o) => o.goalId === goal.id)).toBe(false);
  });

  it("ignores goals where a higher sprint has tasks (supervisor already replanned)", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint, updated_at)
      VALUES (${bizId}, 'glc-test-progressed', 'active', 'gs-progressed', 1, NOW() - INTERVAL '15 minutes')
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-prog1', 'b', ${goal.id}, 1, 'completed'),
        (${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-prog2', 'b', ${goal.id}, 2, 'pending')
    `;

    const orphans = await findOrphanedWakeUps(sql);
    expect(orphans.some((o) => o.goalId === goal.id)).toBe(false);
  });
});

describe("findSupervisorWakeReconciliationCandidates", () => {
  it("finds active goals whose newest task is terminal and already marked woken", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint)
      VALUES (${bizId}, 'glc-test-reconcile', 'active', 'gs-reconcile', 1)
      RETURNING *
    `;
    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, goal_id,
        sprint_number, status, updated_at
      )
      VALUES (
        ${bizId}, 'glc-test-role', 'goal-supervisor', 'glc-test-reconcile-task',
        'b', ${goal.id}, 1, 'completed', NOW() - INTERVAL '5 minutes'
      )
      RETURNING *
    `;

    const candidates = await findSupervisorWakeReconciliationCandidates(sql);
    const match = candidates.find((c) => c.goalId === goal.id);

    expect(match).toBeDefined();
    expect(match!.sprintNumber).toBe(1);
    expect(match!.newestTaskId).toBe(task.id);
    expect(match!.newestTaskStatus).toBe("completed");
  });

  it("ignores goals with open tasks", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint)
      VALUES (${bizId}, 'glc-test-reconcile-open', 'active', 'gs-reconcile-open', 1)
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, goal_id,
        sprint_number, status, updated_at
      )
      VALUES
        (
          ${bizId}, 'glc-test-role', 'goal-supervisor',
          'glc-test-reconcile-open-1', 'b', ${goal.id}, 1,
          'completed', NOW() - INTERVAL '5 minutes'
        ),
        (
          ${bizId}, 'glc-test-role', 'goal-supervisor',
          'glc-test-reconcile-open-2', 'b', ${goal.id}, 1,
          'pending', NOW() - INTERVAL '6 minutes'
        )
    `;

    const candidates = await findSupervisorWakeReconciliationCandidates(sql);
    expect(candidates.some((c) => c.goalId === goal.id)).toBe(false);
  });

  it("ignores fresh terminal tasks", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint)
      VALUES (${bizId}, 'glc-test-reconcile-fresh', 'active', 'gs-reconcile-fresh', 1)
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, goal_id,
        sprint_number, status, updated_at
      )
      VALUES (
        ${bizId}, 'glc-test-role', 'goal-supervisor',
        'glc-test-reconcile-fresh-1', 'b', ${goal.id}, 1,
        'completed', NOW()
      )
    `;

    const candidates = await findSupervisorWakeReconciliationCandidates(sql);
    expect(candidates.some((c) => c.goalId === goal.id)).toBe(false);
  });
});
