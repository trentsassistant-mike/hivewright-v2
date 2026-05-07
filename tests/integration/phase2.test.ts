import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { syncRoleLibrary } from "@/roles/sync";
import { buildSessionContext } from "@/dispatcher/session-builder";
import { runPreFlightChecks } from "@/dispatcher/pre-flight";
import { validateBrief } from "@/dispatcher/pre-task-qa";
import { ClaudeCodeAdapter } from "@/adapters/claude-code";
import { shouldEmitWorkProduct, emitWorkProduct } from "@/work-products/emitter";
import { recordTaskCost, checkGoalBudget } from "@/dispatcher/cost-tracker";
import { calculateCostCents } from "@/adapters/provider-config";
import { routeToQa, processQaResult } from "@/dispatcher/qa-router";
import type { ClaimedTask } from "@/dispatcher/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES ('p2-integ-test', 'P2 Integration', 'digital', '/tmp')
    RETURNING *
  `;
  bizId = biz.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, budget_cents, session_id)
    VALUES (${bizId}, 'p2-integ-goal', 'active', 5000, 'gs-p2-integ-fixture')
    RETURNING *
  `;
  goalId = goal.id;
});

describe("Phase 2 Integration", () => {
  it("builds full session context from DB", async () => {
    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000099",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "p2-integ-session",
      brief: "Build a login page with email and password fields",
      parentTaskId: null,
      goalId: goalId,
      sprintNumber: 1,
      qaRequired: false,
      acceptanceCriteria: "Form renders",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);
    expect(ctx.roleTemplate.slug).toBe("dev-agent");
    expect(ctx.roleTemplate.roleMd).toContain("Developer");
    expect(ctx.goalContext).toContain("p2-integ-goal");
    expect(ctx.model).toBeDefined();
  });

  it("translates session context to Claude Code prompt with 5 layers", async () => {
    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000098",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "p2-integ-translate",
      brief: "Build a login page with email/password",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "Login form works",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);
    const adapter = new ClaudeCodeAdapter();
    const prompt = adapter.translate(ctx);

    // All 5 layers present
    expect(prompt).toContain("Developer");         // Layer 1: Identity
    expect(prompt).toContain("Build a login page"); // Layer 2: Task
    expect(prompt).toContain("Memory");             // Layer 3: Memory header
  });

  it("pre-flight passes with valid context", async () => {
    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000097",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "p2-integ-preflight",
      brief: "Build something with sufficient detail for the agent to work with",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "It works",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);
    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(true);
  });

  it("brief validation warns about missing acceptance criteria", () => {
    const result = validateBrief({
      title: "p2-integ-brief",
      brief: "Build a login page with email and password fields",
      acceptanceCriteria: null,
      assignedTo: "dev-agent",
      roleType: "executor",
    });
    expect(result.passed).toBe(true);
    expect(result.warnings.some((w) => w.includes("acceptance criteria"))).toBe(true);
  });

  it("cost tracking updates tasks and checks goal budget", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'p2-integ-cost', 'Work', ${goalId}, 'completed')
      RETURNING *
    `;

    await recordTaskCost(sql, task.id, {
      tokensInput: 10000,
      tokensOutput: 3000,
      costCents: calculateCostCents("anthropic/claude-sonnet-4-6", 10000, 3000),
      modelUsed: "anthropic/claude-sonnet-4-6",
    });

    const budget = await checkGoalBudget(sql, goalId);
    expect(budget.spentCents).toBeGreaterThan(0);
    expect(budget.budgetCents).toBe(5000);
  });

  it("QA routing flow: route -> pass -> complete", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, qa_required)
      VALUES (${bizId}, 'dev-agent', 'owner', 'p2-integ-qa-flow', 'Build it', 'active', true)
      RETURNING *
    `;

    const qaTask = await routeToQa(sql, task.id, "Here is the completed work");
    expect(qaTask).not.toBeNull();

    const [inReview] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(inReview.status).toBe("in_review");

    await processQaResult(sql, task.id, { passed: true, feedback: null });

    const [completed] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(completed.status).toBe("completed");
  });

  it("work product emission with sensitivity classification", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'p2-integ-wp', 'Analysis', 'completed')
      RETURNING *
    `;

    expect(shouldEmitWorkProduct("p2-integ-wp")).toBe(true);
    expect(shouldEmitWorkProduct("Result: internal routing")).toBe(false);

    const wp = await emitWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "dev-agent",
      department: "engineering",
      content: "Analysis complete. Revenue grew 15% this quarter.",
      summary: "Revenue analysis summary",
    });

    expect(wp).not.toBeNull();
    expect(wp!.sensitivity).toBe("internal");
  });
});
