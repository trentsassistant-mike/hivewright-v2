import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { completeGoal } from "@/goals/completion";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { vi } from "vitest";
import * as gate from "@/software-pipeline/landed-state-gate";

vi.mock("@/software-pipeline/landed-state-gate", () => ({
  verifyLandedState: vi.fn(),
}));

let bizId: string;
let goalId: string;
let tmp: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "completion-"));
  const cfgPath = path.join(tmp, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;

  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('goalcomp-biz', 'Goal Comp', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, budget_cents, spent_cents, session_id)
    VALUES (${bizId}, 'goalcomp-goal', 'active', 5000, 2500, 'gs-test-123')
    RETURNING *
  `;
  goalId = goal.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES
      ('goalcomp-role', 'Goal Comp Role', 'executor', 'claude-code'),
      ('doctor', 'Doctor', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  vi.mocked(gate.verifyLandedState).mockResolvedValue({ ok: true, failures: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

describe("completeGoal", () => {
  it("marks goal as achieved and clears session", async () => {
    await completeGoal(sql, goalId, "goalcomp: Everything was accomplished successfully");

    const [goal] = await sql`SELECT status, session_id FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("achieved");
    expect(goal.session_id).toBeNull();
  });

  it("writes completion summary to hive memory", async () => {
    await completeGoal(sql, goalId, "goalcomp: Built the entire website");

    const memories = await sql`
      SELECT * FROM hive_memory WHERE hive_id = ${bizId} AND content LIKE '%goalcomp%'
    `;
    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(memories[0].category).toBe("general");
  });

  it("writes a goal_completions audit row with evidence", async () => {
    const taskId = (await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'goalcomp-role', 'system', 'goalcomp-evidence-task', 'evidence task', ${goalId})
      RETURNING id
    `)[0].id;

    await completeGoal(sql, goalId, "goalcomp: shipped with evidence", {
      createdBy: "goal-supervisor",
      evidenceTaskIds: [taskId],
      evidenceWorkProductIds: [],
    });

    const completions = await sql`
      SELECT id, goal_id, summary, evidence, created_by FROM goal_completions
      WHERE goal_id = ${goalId}
    `;
    expect(completions.length).toBe(1);
    expect(completions[0].summary).toBe("goalcomp: shipped with evidence");
    expect(completions[0].created_by).toBe("goal-supervisor");
    expect(completions[0].evidence).toEqual({ taskIds: [taskId] });
  });

  it("defaults createdBy to 'goal-supervisor' and accepts no evidence", async () => {
    await completeGoal(sql, goalId, "goalcomp: minimal call");

    const completions = await sql`
      SELECT created_by, evidence FROM goal_completions WHERE goal_id = ${goalId}
    `;
    expect(completions.length).toBe(1);
    expect(completions[0].created_by).toBe("goal-supervisor");
    expect(completions[0].evidence).toEqual({});
  });

  it("cascades cancel to non-terminal descendants (direct + via parent_task_id)", async () => {
    // Direct child: failed goal task.
    const [failedDirect] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, status, priority, title, brief, failure_reason)
      VALUES (${bizId}, ${goalId}, 'goalcomp-role', 'supervisor', 'failed', 5, 'failed direct', 'b', 'Reached maximum turn limit')
      RETURNING id
    `;
    // Completed direct child — must be preserved, not re-cancelled.
    const [completedDirect] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, status, priority, title, brief)
      VALUES (${bizId}, ${goalId}, 'goalcomp-role', 'supervisor', 'completed', 5, 'completed direct', 'b')
      RETURNING id
    `;
    // Doctor child of the failed task — unresolvable. Mirrors today's
    // aa61a6ba-7994-4e4b-b8a0-4b6541e8945d situation where doctor-of-doctor
    // descendants kept the "N unresolvable tasks" banner lit after the
    // supervisor marked the parent goal achieved.
    const [unresolvableGrandchild] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief, parent_task_id, failure_reason)
      VALUES (${bizId}, 'doctor', 'dispatcher', 'unresolvable', 5, 'doctor diagnose', 'b', ${failedDirect.id}, 'Parse failure')
      RETURNING id
    `;

    await completeGoal(sql, goalId, "cascade test");

    const [failed] = await sql<{ status: string; result_summary: string | null; failure_reason: string | null }[]>`
      SELECT status, result_summary, failure_reason FROM tasks WHERE id = ${failedDirect.id}
    `;
    expect(failed.status).toBe("cancelled");
    expect(failed.result_summary).toContain("Cancelled by goal completion");
    expect(failed.failure_reason).toBeNull();

    const [grandchild] = await sql<{ status: string; result_summary: string | null; failure_reason: string | null }[]>`
      SELECT status, result_summary, failure_reason FROM tasks WHERE id = ${unresolvableGrandchild.id}
    `;
    expect(grandchild.status).toBe("cancelled");
    expect(grandchild.result_summary).toContain("Cancelled by goal completion");
    expect(grandchild.failure_reason).toBeNull();

    const [completed] = await sql<{ status: string }[]>`
      SELECT status FROM tasks WHERE id = ${completedDirect.id}
    `;
    expect(completed.status).toBe("completed");
  });
});
