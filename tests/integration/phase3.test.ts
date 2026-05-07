import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as gate from "@/software-pipeline/landed-state-gate";
import { syncRoleLibrary } from "@/roles/sync";
import { executeSupervisorTool } from "@/goals/supervisor-tools";

import { buildSupervisorInitialPrompt, buildSprintWakeUpPrompt, createSupervisorSession } from "@/goals/supervisor-session";
import { completeGoal } from "@/goals/completion";
import { shouldCompact, buildCompactionRequest, buildCompactedSessionPrompt } from "@/goals/compaction";
import { findNewGoals, findCompletedSprintsForWakeUp } from "@/dispatcher/goal-lifecycle";
import { testSql as sql, truncateAll } from "../_lib/test-db";

vi.mock("@/software-pipeline/landed-state-gate", () => ({
  verifyLandedState: vi.fn(),
}));

let bizId: string;
let goalId: string;
let tmp: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-"));
  const cfgPath = path.join(tmp, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;
  vi.mocked(gate.verifyLandedState).mockResolvedValue({ ok: true, failures: [] });

  await truncateAll(sql);
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, description)
    VALUES ('p3-integ', 'P3 Integration', 'digital', 'Test hive for Phase 3')
    RETURNING *
  `;
  bizId = biz.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, description, status, budget_cents)
    VALUES (${bizId}, 'p3-integ-goal', 'Build an amazing product from scratch', 'active', 10000)
    RETURNING *
  `;
  goalId = goal.id;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

describe("Phase 3 Integration", () => {
  it("detects new goal and creates supervisor session", async () => {
    // Goal has no session yet
    const newGoals = await findNewGoals(sql);
    expect(newGoals.some((g) => g.id === goalId)).toBe(true);

    // Create session
    const session = await createSupervisorSession(sql, goalId);
    expect(session.sessionId).toContain("gs-");

    // No longer appears in new goals
    const afterCreate = await findNewGoals(sql);
    expect(afterCreate.some((g) => g.id === goalId)).toBe(false);
  });

  it("builds initial supervisor prompt with role library and tools", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("p3-integ-goal");
    expect(prompt).toContain("dev-agent");
    expect(prompt).toContain("create_task");
    expect(prompt).toContain("mark_goal_achieved");
    expect(prompt).toContain("P3 Integration"); // hive name
  });

  it("supervisor creates sprint tasks via tool execution", async () => {
    // task_kind: 'research' exempts this task from acceptance_criteria requirement
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "dev-agent",
      title: "p3-integ-task1",
      brief: "Research the market requirements and competitive landscape",
      task_kind: "research",
      sprint_number: 1,
      qa_required: false,
    });
    expect(result.success).toBe(true);

    const result2 = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "research-analyst",
      title: "p3-integ-task2",
      brief: "Analyze competitor products",
      acceptance_criteria: "Competitor matrix with 3+ entries and feature comparison",
      sprint_number: 1,
      qa_required: true,
    });
    expect(result2.success).toBe(true);
  });

  it("builds sprint wake-up prompt after tasks complete", async () => {
    // Seed completed sprint 1 tasks directly
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status, result_summary)
      VALUES
        (${bizId}, 'dev-agent', 'goal-supervisor', 'p3-integ-task1', 'Brief', ${goalId}, 1, 'completed', 'Market research done.'),
        (${bizId}, 'research-analyst', 'goal-supervisor', 'p3-integ-task2', 'Brief', ${goalId}, 1, 'completed', 'Found 3 key competitors.')
    `;

    const prompt = await buildSprintWakeUpPrompt(sql, goalId, 1);
    // Paperclip upgrade: wake-up prompt now says "Settled" (not "Complete")
    // to avoid implying a cancelled-only sprint was successful.
    expect(prompt).toContain("Sprint 1 Settled");
    expect(prompt).toContain("Market research done");
    expect(prompt).toContain("3 key competitors");
  });

  it("detects completed sprints for wake-up", async () => {
    // findCompletedSprintsForWakeUp requires g.session_id IS NOT NULL — set one
    await sql`UPDATE goals SET session_id = 'gs-p3-integ-detect' WHERE id = ${goalId}`;

    // Seed completed sprint tasks
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'dev-agent', 'goal-supervisor', 'p3-integ-sprint-t1', 'Brief', ${goalId}, 1, 'completed'),
        (${bizId}, 'research-analyst', 'goal-supervisor', 'p3-integ-sprint-t2', 'Brief', ${goalId}, 1, 'completed')
    `;
    const completed = await findCompletedSprintsForWakeUp(sql);
    expect(completed.some((c) => c.goalId === goalId && c.sprintNumber === 1)).toBe(true);
  });

  it("context compaction works end-to-end", () => {
    expect(shouldCompact(50000, 200000)).toBe(false);
    expect(shouldCompact(140000, 200000)).toBe(true);

    const request = buildCompactionRequest();
    expect(request).toContain("handover brief");

    const resumed = buildCompactedSessionPrompt("Original prompt", "Here is my handover");
    expect(resumed).toContain("Original prompt");
    expect(resumed).toContain("Here is my handover");
  });

  it("goal completion writes memory and clears session", async () => {
    await completeGoal(sql, goalId, "p3-integ: All objectives met, product launched successfully");

    const [goal] = await sql`SELECT status, session_id FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("achieved");
    expect(goal.session_id).toBeNull();

    const mem = await sql`
      SELECT * FROM hive_memory WHERE hive_id = ${bizId} AND content LIKE '%p3-integ%'
    `;
    expect(mem.length).toBeGreaterThanOrEqual(1);
  });
});
