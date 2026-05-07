import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { executeSupervisorTool, SUPERVISOR_TOOLS } from "@/goals/supervisor-tools";
import { getGoalPlan } from "@/goals/goal-documents";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;
let tmp: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-tools-"));
  const cfgPath = path.join(tmp, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;

  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('suptool-biz', 'SupTool Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('suptool-role', 'ST Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  // session_id set so the running dispatcher's findNewGoals
  // (WHERE session_id IS NULL) skips this fixture and doesn't create
  // real tasks against it in parallel with the test.
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, budget_cents, session_id)
    VALUES (${bizId}, 'suptool-goal', 'active', 5000, 'gs-suptool-test-fixture')
    RETURNING *
  `;
  goalId = goal.id;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

describe("SUPERVISOR_TOOLS", () => {
  it("defines all required tool names", () => {
    const names = SUPERVISOR_TOOLS.map((t) => t.name);
    expect(names).toContain("create_task");
    expect(names).toContain("create_sub_goal");
    expect(names).toContain("create_decision");
    expect(names).toContain("create_schedule");
    expect(names).toContain("mark_goal_achieved");
    expect(names).toContain("get_role_library");
  });

  it("guides route-choice decisions to include existing credential and subscription paths", () => {
    const createDecision = SUPERVISOR_TOOLS.find((tool) => tool.name === "create_decision");
    expect(createDecision?.description).toContain("reuse an existing credential");
    expect(createDecision?.description).toContain("Codex auth");
    expect(createDecision?.parameters.options.description).toContain("reuse-existing");
  });
});

describe("executeSupervisorTool", () => {
  it("creates a task via create_task", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "suptool-role",
      title: "suptool-task-1",
      brief: "Do the research",
      acceptance_criteria: "Research doc covers all competitors",
      sprint_number: 1,
      qa_required: false,
    });
    expect(result.success).toBe(true);

    const tasks = await sql`SELECT * FROM tasks WHERE title = 'suptool-task-1'`;
    expect(tasks.length).toBe(1);
    expect(tasks[0].goal_id).toBe(goalId);
    expect(tasks[0].sprint_number).toBe(1);
    expect(tasks[0].created_by).toBe("goal-supervisor");
  });

  it("blocks goal-supervisor replacement tasks when the source task family budget is exhausted", async () => {
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, failure_reason)
      VALUES (${bizId}, 'suptool-role', 'goal-supervisor', 'failed', 'source failure', 'original work', ${goalId}, 'QA failed')
      RETURNING id
    `;
    for (let i = 1; i <= 3; i += 1) {
      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, parent_task_id)
        VALUES (${bizId}, 'suptool-role', 'goal-supervisor', 'failed', ${`replacement ${i}`}, 'follow-up work', ${goalId}, ${sourceTask.id})
      `;
    }

    const result = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "suptool-role",
      title: "replacement 4",
      brief: "Try one more recovery task",
      acceptance_criteria: "Recovery task is verified",
      sprint_number: 2,
      sourceTaskId: sourceTask.id,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Recovery budget exhausted");

    const created = await sql`SELECT id FROM tasks WHERE title = 'replacement 4'`;
    expect(created.length).toBe(0);

    const [parked] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${sourceTask.id}
    `;
    expect(parked.status).toBe("unresolvable");
    expect(parked.failure_reason).toContain("replacement tasks");
  });

  it("links allowed goal-supervisor replacement tasks to the source task", async () => {
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, failure_reason)
      VALUES (${bizId}, 'suptool-role', 'goal-supervisor', 'failed', 'link source failure', 'original work', ${goalId}, 'QA failed')
      RETURNING id
    `;

    const result = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "suptool-role",
      title: "linked replacement",
      brief: "Create a bounded recovery task",
      acceptance_criteria: "Recovery task is verified",
      sprint_number: 2,
      source_task_id: sourceTask.id,
    });

    expect(result.success).toBe(true);

    const [created] = await sql<{ parent_task_id: string | null }[]>`
      SELECT parent_task_id FROM tasks WHERE title = 'linked replacement'
    `;
    expect(created.parent_task_id).toBe(sourceTask.id);
  });

  it("creates a sub-goal via create_sub_goal", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_sub_goal", {
      title: "suptool-subgoal",
      description: "Handle the finance side",
    });
    expect(result.success).toBe(true);

    const subGoals = await sql`SELECT * FROM goals WHERE parent_id = ${goalId}`;
    expect(subGoals.length).toBe(1);
    expect(subGoals[0].title).toBe("suptool-subgoal");
    expect(subGoals[0].hive_id).toBe(bizId);
  });

  it("creates a decision via create_decision", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_decision", {
      title: "suptool-decision",
      context: "Need budget increase",
      recommendation: "Increase by $50",
      priority: "normal",
    });
    expect(result.success).toBe(true);

    const decisions = await sql`SELECT * FROM decisions WHERE title = 'suptool-decision'`;
    expect(decisions.length).toBe(1);
    expect(decisions[0].goal_id).toBe(goalId);
    // EA-first pipeline: non-auto-approved supervisor decisions go to EA review.
    expect(decisions[0].status).toBe("ea_review");
  });

  it("creates schedules with an object task template", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_schedule", {
      cron_expression: "0 8 * * 1",
      task_template: {
        kind: "weekly-research-review",
        assignedTo: "suptool-role",
        title: "Weekly research review",
        brief: "Review recurring research output.",
      },
    });
    expect(result.success).toBe(true);

    const [schedule] = await sql<{ stored_as: string; title: string | null; kind: string | null }[]>`
      SELECT
        jsonb_typeof(task_template) AS stored_as,
        task_template ->> 'title' AS title,
        task_template ->> 'kind' AS kind
      FROM schedules
      WHERE hive_id = ${bizId}
      LIMIT 1
    `;

    expect(schedule.stored_as).toBe("object");
    expect(schedule.title).toBe("Weekly research review");
    expect(schedule.kind).toBe("weekly-research-review");
  });

  it("blocks goal-supervisor recovery decisions when the source task already has an open recovery decision", async () => {
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, failure_reason)
      VALUES (${bizId}, 'suptool-role', 'goal-supervisor', 'failed', 'decision source failure', 'original work', ${goalId}, 'Needs owner input')
      RETURNING id
    `;
    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation, priority, status)
      VALUES (${bizId}, ${goalId}, ${sourceTask.id}, 'Existing recovery decision', 'Already waiting', 'Wait', 'normal', 'ea_review')
    `;

    const result = await executeSupervisorTool(sql, goalId, bizId, "create_decision", {
      title: "Duplicate recovery decision",
      context: "Ask again for the same failed task.",
      recommendation: "Escalate again.",
      priority: "normal",
      sourceTaskId: sourceTask.id,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Recovery budget exhausted");

    const decisions = await sql`SELECT id FROM decisions WHERE title = 'Duplicate recovery decision'`;
    expect(decisions.length).toBe(0);

    const [parked] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${sourceTask.id}
    `;
    expect(parked.status).toBe("unresolvable");
    expect(parked.failure_reason).toContain("open recovery decisions");
  });

  it("links allowed goal-supervisor recovery decisions to the source task", async () => {
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, failure_reason)
      VALUES (${bizId}, 'suptool-role', 'goal-supervisor', 'failed', 'linked decision source', 'original work', ${goalId}, 'Needs owner input')
      RETURNING id
    `;

    const result = await executeSupervisorTool(sql, goalId, bizId, "create_decision", {
      title: "Linked recovery decision",
      context: "Ask once for the failed task.",
      recommendation: "Escalate once.",
      priority: "normal",
      source_task_id: sourceTask.id,
    });

    expect(result.success).toBe(true);

    const [decision] = await sql<{ task_id: string | null }[]>`
      SELECT task_id FROM decisions WHERE title = 'Linked recovery decision'
    `;
    expect(decision.task_id).toBe(sourceTask.id);
  });

  it("passes structured named options through create_decision", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_decision", {
      title: "Choose Gemini CLI auth path",
      context: "The adapter needs a runtime auth path.",
      recommendation: "Use GCA login.",
      priority: "urgent",
      options: [
        {
          key: "api-key-runtime",
          label: "Use Gemini API key runtime",
          consequence: "Fast but stores a credential.",
          response: "approved",
        },
        {
          key: "gca-login",
          label: "Use GCA login",
          consequence: "Owner can select this directly instead of using Discuss.",
          response: "approved",
        },
        {
          key: "defer-gemini-adapter",
          label: "Defer Gemini adapter work",
          consequence: "Leaves the goal parked.",
          response: "rejected",
        },
      ],
    });
    expect(result.success).toBe(true);

    const [decision] = await sql<{ options: Array<{ key: string; label: string; response: string }> }[]>`
      SELECT options FROM decisions WHERE title = 'Choose Gemini CLI auth path'
    `;
    expect(decision.options).toEqual([
      expect.objectContaining({ key: "api-key-runtime", label: "Use Gemini API key runtime", response: "approved" }),
      expect.objectContaining({ key: "gca-login", label: "Use GCA login", response: "approved" }),
      expect.objectContaining({ key: "defer-gemini-adapter", response: "rejected" }),
    ]);
  });

  it("keeps simple approve/reject decisions valid without named options", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_decision", {
      title: "Approve extra budget",
      context: "The sprint needs another $50.",
      recommendation: "Approve the spend.",
      priority: "normal",
    });
    expect(result.success).toBe(true);

    const [decision] = await sql<{ options: unknown }[]>`
      SELECT options FROM decisions WHERE title = 'Approve extra budget'
    `;
    expect(decision.options).toBeNull();
  });

  it("rejects malformed named decision options", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_decision", {
      title: "Choose malformed auth path",
      context: "The adapter needs a runtime auth path.",
      recommendation: "Use GCA login.",
      options: [
        {
          key: "gca-login",
          label: "Use GCA login",
          consequence: 3,
          response: "approved",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/options/i);
  });

  it("creates an auto_approved decision when auto_approve is true", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_decision", {
      title: "suptool-auto-decision",
      context: "Tier 2 autonomous action taken",
      recommendation: "Already acted on this",
      priority: "normal",
      auto_approve: true,
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("decisionId");

    const decisions = await sql`SELECT * FROM decisions WHERE title = 'suptool-auto-decision'`;
    expect(decisions.length).toBe(1);
    expect(decisions[0].status).toBe("auto_approved");
    expect(decisions[0].goal_id).toBe(goalId);
  });

  it("marks goal achieved via mark_goal_achieved (clears session, writes canonical memory)", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "mark_goal_achieved", {
      summary: "suptool: Everything is done!",
    });
    expect(result.success).toBe(true);

    // Goal is achieved AND session_id is cleared (so the dispatcher stops tracking it).
    // Pre-fix bug: session_id stayed populated after status flipped to 'achieved'.
    const [goal] = await sql`SELECT status, session_id FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("achieved");
    expect(goal.session_id).toBeNull();

    // Memory entry uses the canonical completeGoal() format which includes the goal title.
    // Pre-fix bug: inline impl wrote "Goal achieved: <summary>" without the title.
    const mem = await sql`
      SELECT * FROM hive_memory
      WHERE hive_id = ${bizId}
        AND content LIKE '%suptool%'
    `;
    expect(mem.length).toBeGreaterThanOrEqual(1);
    expect(mem[0].content).toContain('Goal "suptool-goal" achieved');
  });

  it("rejects mark_goal_achieved with missing or empty summary", async () => {
    const missing = await executeSupervisorTool(sql, goalId, bizId, "mark_goal_achieved", {});
    expect(missing.success).toBe(false);
    expect(missing.message).toMatch(/summary/i);

    const empty = await executeSupervisorTool(sql, goalId, bizId, "mark_goal_achieved", { summary: "" });
    expect(empty.success).toBe(false);
    expect(empty.message).toMatch(/summary/i);

    const whitespace = await executeSupervisorTool(sql, goalId, bizId, "mark_goal_achieved", { summary: "   " });
    expect(whitespace.success).toBe(false);
    expect(whitespace.message).toMatch(/summary/i);

    // Goal should NOT have been touched.
    const [goal] = await sql`SELECT status, session_id FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
    expect(goal.session_id).toBe("gs-suptool-test-fixture");
  });

  it("returns role library via get_role_library", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "get_role_library", {});
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("returns error for unknown tool", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "nonexistent_tool", {});
    expect(result.success).toBe(false);
  });
});

describe("executeSupervisorTool — create_goal_plan", () => {
  it("creates a plan document on first call", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_goal_plan", {
      title: "suptool-plan",
      body: "# Goal Summary\nDo the work.",
    });
    expect(result.success).toBe(true);

    const plan = await getGoalPlan(sql, goalId);
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("suptool-plan");
    expect(plan!.body).toContain("Do the work.");
    expect(plan!.revision).toBe(1);
    expect(plan!.createdBy).toBe("goal-supervisor");
  });

  it("updates existing plan and bumps revision on second call", async () => {
    await executeSupervisorTool(sql, goalId, bizId, "create_goal_plan", {
      title: "suptool-plan",
      body: "v1",
    });
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_goal_plan", {
      title: "suptool-plan",
      body: "v2",
    });
    expect(result.success).toBe(true);

    const plan = await getGoalPlan(sql, goalId);
    expect(plan!.body).toBe("v2");
    expect(plan!.revision).toBe(2);
  });

  it("rejects missing title or body", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_goal_plan", {
      title: "suptool-plan",
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/body/i);
  });
});

describe("executeSupervisorTool — create_task acceptance criteria", () => {
  it("rejects create_task without acceptance_criteria", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "suptool-role",
      title: "suptool-missing-ac",
      brief: "Do something",
      sprint_number: 1,
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/acceptance_criteria/i);

    const tasks = await sql`SELECT * FROM tasks WHERE title = 'suptool-missing-ac'`;
    expect(tasks.length).toBe(0);
  });

  it("persists acceptance_criteria when provided", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "suptool-role",
      title: "suptool-with-ac",
      brief: "Implement feature X",
      acceptance_criteria: "Feature X renders, unit tests pass, screenshot attached",
      sprint_number: 1,
    });
    expect(result.success).toBe(true);

    const [task] = await sql`SELECT * FROM tasks WHERE title = 'suptool-with-ac'`;
    expect(task.acceptance_criteria).toContain("Feature X renders");
  });

  it("allows research tasks without acceptance_criteria", async () => {
    const result = await executeSupervisorTool(sql, goalId, bizId, "create_task", {
      assigned_to: "suptool-role",
      title: "suptool-research",
      brief: "Investigate the problem space",
      task_kind: "research",
      sprint_number: 1,
    });
    expect(result.success).toBe(true);
  });
});

describe("SUPERVISOR_TOOLS — updated tool set", () => {
  it("includes create_goal_plan", () => {
    const names = SUPERVISOR_TOOLS.map((t) => t.name);
    expect(names).toContain("create_goal_plan");
  });

  it("marks acceptance_criteria as a declared parameter in create_task schema", () => {
    const createTask = SUPERVISOR_TOOLS.find((t) => t.name === "create_task");
    expect(createTask).toBeDefined();
    const ac = createTask!.parameters.acceptance_criteria;
    expect(ac).toBeDefined();
  });
});
