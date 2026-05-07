import { describe, it, expect, beforeEach } from "vitest";
import {
  notifyGoalSupervisorOfQaFailure,
  routeToQa,
  processQaResult,
  parseQaVerdict,
} from "@/dispatcher/qa-router";
import { emitWorkProduct } from "@/work-products/emitter";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('qa-test-biz', 'QA Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('qa-test-role', 'QA Test Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('qa', 'QA Reviewer', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});


describe("routeToQa", () => {
  it("creates a QA task and sets original to in_review", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, qa_required)
      VALUES (${bizId}, 'qa-test-role', 'owner', 'qa-test-original', 'Do work', 'active', true)
      RETURNING *
    `;

    const qaTask = await routeToQa(sql, task.id, "The completed deliverable output");

    expect(qaTask).not.toBeNull();
    expect(qaTask!.assigned_to).toBe("qa");
    expect(qaTask!.title).toContain("qa-test-original");

    const [original] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(original.status).toBe("in_review");
  });

  it("includes the deliverable in the QA brief", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, acceptance_criteria)
      VALUES (${bizId}, 'qa-test-role', 'owner', 'qa-test-content', 'Build thing', 'active', 'It must work')
      RETURNING *
    `;

    const qaTask = await routeToQa(sql, task.id, "Here is the completed work product");
    expect(qaTask!.brief).toContain("completed work product");
    expect(qaTask!.brief).toContain("It must work");
  });

  it("copies parent workspace metadata to the QA task", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, qa_required)
      VALUES (${bizId}, 'qa-test-role', 'owner', 'qa-test-workspace', 'Do work', 'active', true)
      RETURNING *
    `;
    await sql`
      INSERT INTO task_workspaces (
        task_id, base_workspace_path, worktree_path, branch_name,
        isolation_status, isolation_active, reused
      )
      VALUES (
        ${task.id}, '/repo/base', '/repo/base/.claude/worktrees/work',
        'hw/task/work-qa-test-role', 'active', true, false
      )
    `;

    const qaTask = await routeToQa(sql, task.id, "workspace-sensitive deliverable");
    const [workspace] = await sql`
      SELECT worktree_path, branch_name, reused
      FROM task_workspaces
      WHERE task_id = ${qaTask!.id as string}
    `;
    expect(workspace.worktree_path).toBe("/repo/base/.claude/worktrees/work");
    expect(workspace.branch_name).toBe("hw/task/work-qa-test-role");
    expect(workspace.reused).toBe(true);
  });

  it("references a long Codex-style deliverable from QA while preserving work_products evidence", async () => {
    const tail = "TAIL_SENTINEL: commands section, tasks-page entry, theme-toggle, nav-links, dashboard page";
    const longDeliverable = `${Array.from({ length: 500 }, (_, i) => `codex-output-${i}: ${"x".repeat(100)}`).join("\n")}\n${tail}`;
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, qa_required)
      VALUES (${bizId}, 'qa-test-role', 'owner', 'qa-test-long-codex-output', 'Build long thing', 'active', true)
      RETURNING *
    `;

    await emitWorkProduct(sql, {
      taskId: task.id,
      hiveId: bizId,
      roleSlug: "qa-test-role",
      department: "engineering",
      content: longDeliverable,
      summary: longDeliverable,
    });
    const qaTask = await routeToQa(sql, task.id, longDeliverable);

    const [workProduct] = await sql<{ content: string; summary: string | null }[]>`
      SELECT content, summary FROM work_products WHERE task_id = ${task.id}
    `;
    expect(workProduct.content).toBe(longDeliverable);
    expect(workProduct.summary).toBe(longDeliverable);
    expect(workProduct.content).toContain(tail);
    expect(qaTask!.brief).toContain("### Work Product / Completed Deliverable");
    expect(qaTask!.brief).toContain("### Evidence References");
    expect(qaTask!.brief).toContain("work_products.id");
    expect(qaTask!.brief).not.toContain("codex-output-250");
    expect(qaTask!.brief).not.toContain(tail);
  });
});

describe("parseQaVerdict", () => {
  it("returns pass for a standalone 'pass' line", () => {
    expect(parseQaVerdict("Looks good.\n\npass\n\nAll criteria met.")).toBe("pass");
  });

  it("returns fail for a standalone 'fail' line", () => {
    expect(parseQaVerdict("Missing screenshot artifacts.\n\nfail\n")).toBe("fail");
  });

  it("ignores 'pass/fail' mentioned as a concept in preamble", () => {
    const output = [
      "I'm checking the cited repo state before issuing a pass/fail.",
      "I've confirmed the artifacts.",
      "",
      "pass",
      "",
      "The deliverable meets the acceptance criteria.",
    ].join("\n");
    expect(parseQaVerdict(output)).toBe("pass");
  });

  it("treats 'Verdict: FAIL' prefix line as a fail", () => {
    expect(parseQaVerdict("Review notes...\nVerdict: FAIL\n")).toBe("fail");
  });

  it("treats markdown-decorated verdict lines as a verdict", () => {
    expect(parseQaVerdict("# Review\n\n**pass**\n\nDetails follow.")).toBe("pass");
  });

  it("returns unknown when no standalone verdict is present", () => {
    expect(parseQaVerdict("I could not locate the deliverable in the repo.")).toBe("unknown");
  });

  it("uses the last verdict when multiple are present", () => {
    const output = ["Verdict: fail", "", "After rework:", "", "pass"].join("\n");
    expect(parseQaVerdict(output)).toBe("pass");
  });
});

describe("processQaResult", () => {
  it("marks task completed on QA pass and clears stale failure_reason", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'qa-test-role', 'owner', 'qa-test-pass', 'Do work', 'in_review', 'Watchdog: no heartbeat within timeout period')
      RETURNING *
    `;

    await processQaResult(sql, task.id, { passed: true, feedback: null });

    const [updated] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("completed");
    expect(updated.failure_reason).toBeNull();
  });

  it("resets task to pending on QA fail with feedback appended", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'qa-test-role', 'owner', 'qa-test-fail', 'Do work', 'in_review')
      RETURNING *
    `;

    await processQaResult(sql, task.id, { passed: false, feedback: "Missing error handling" });

    const [updated] = await sql`SELECT status, brief FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.brief).toContain("Missing error handling");
    expect(updated.brief).toContain("QA Feedback");
  });

  it("creates an owner decision and blocks a direct task when the QA retry cap is reached", async () => {
    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status,
        retry_count, result_summary, acceptance_criteria
      )
      VALUES (
        ${bizId},
        'qa-test-role',
        'owner',
        'direct qa cap task',
        'Do direct work\n\n## QA Feedback (Rework Required - attempt 1/2)\nFirst QA failure',
        'in_review',
        2,
        'Latest task summary',
        'Must satisfy QA'
      )
      RETURNING *
    `;

    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content, summary)
      VALUES (${task.id}, ${bizId}, 'qa-test-role', 'Most recent work product body', 'Most recent work product summary')
    `;

    await processQaResult(sql, task.id, { passed: false, feedback: "Second QA failure" });

    const [updated] = await sql`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("blocked");
    expect(updated.failure_reason).toContain("Awaiting owner recovery decision");

    const [decision] = await sql<{
      task_id: string;
      goal_id: string | null;
      title: string;
      context: string;
      recommendation: string | null;
      options: {
        kind: string;
        suggestedOption: string;
        qaFeedbackExcerpt: string;
        options: Array<{ label: string; action: string }>;
      };
      priority: string;
      status: string;
      kind: string;
    }[]>`
      SELECT task_id, goal_id, title, context, recommendation, options, priority, status, kind
      FROM decisions
      WHERE task_id = ${task.id}
    `;
    expect(decision).toBeDefined();
    expect(decision.goal_id).toBeNull();
    expect(decision.status).toBe("ea_review");
    expect(decision.kind).toBe("decision");
    expect(decision.priority).toBe("urgent");
    expect(decision.title).toContain("failed QA twice");
    expect(decision.context).toContain("First QA failure");
    expect(decision.context).toContain("Second QA failure");
    expect(decision.context).toContain("Most recent work product summary");
    expect(decision.options.kind).toBe("direct_task_qa_cap_recovery");
    expect(decision.options.suggestedOption).toBe("refine_brief_and_retry");
    expect(decision.options.qaFeedbackExcerpt).toContain("Second QA failure");
    expect(decision.options.options.map((option) => option.action)).toEqual([
      "retry_with_different_role",
      "refine_brief_and_retry",
      "abandon",
    ]);

    const [candidate] = await sql<{ role_slug: string; slug: string; evidence: unknown[] | string }[]>`
      SELECT role_slug, slug, evidence
      FROM skill_drafts
      WHERE hive_id = ${bizId}
        AND role_slug = 'qa-test-role'
    `;
    const evidence = typeof candidate.evidence === "string"
      ? JSON.parse(candidate.evidence) as unknown[]
      : candidate.evidence;
    expect(candidate.role_slug).toBe("qa-test-role");
    expect(candidate.slug).toBe("qa-test-role-qa-failure-skill-improvement");
    expect(evidence).toHaveLength(1);
    expect(JSON.stringify(evidence)).toContain("Second QA failure");
  });

  it("keeps the goal-task QA cap path on supervisor replan", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${bizId}, 'Goal QA Cap', 'Goal task replan test', 'active')
      RETURNING *
    `;

    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, goal_id, assigned_to, created_by, title, brief, status,
        retry_count, sprint_number, acceptance_criteria
      )
      VALUES (
        ${bizId},
        ${goal.id},
        'qa-test-role',
        'goal-supervisor',
        'goal qa cap task',
        'Do goal work',
        'in_review',
        2,
        3,
        'Goal task must pass QA'
      )
      RETURNING *
    `;
    await sql`
      INSERT INTO task_workspaces (
        task_id, base_workspace_path, worktree_path, branch_name,
        isolation_status, isolation_active, reused
      )
      VALUES (
        ${task.id}, '/repo/base', '/repo/base/.claude/worktrees/qa-cap',
        'hw/task/qa-cap', 'active', true, false
      )
    `;

    await processQaResult(sql, task.id, { passed: false, feedback: "Goal QA failure" });

    const [updated] = await sql`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("failed");
    expect(updated.failure_reason).toContain("Supervisor re-planning required");

    const decisions = await sql`SELECT id FROM decisions WHERE task_id = ${task.id}`;
    expect(decisions).toHaveLength(0);

    const [replan] = await sql<{
      assigned_to: string;
      created_by: string;
      title: string;
      brief: string;
      goal_id: string;
      parent_task_id: string;
      sprint_number: number;
      qa_required: boolean;
    }[]>`
      SELECT assigned_to, created_by, title, brief, goal_id, parent_task_id, sprint_number, qa_required
      FROM tasks
      WHERE parent_task_id = ${task.id}
    `;
    expect(replan.assigned_to).toBe("goal-supervisor");
    expect(replan.created_by).toBe("dispatcher");
    expect(replan.title).toContain("[Replan] QA failed repeatedly");
    expect(replan.brief).toContain("Goal QA failure");
    expect(replan.goal_id).toBe(goal.id);
    expect(replan.parent_task_id).toBe(task.id);
    expect(replan.sprint_number).toBe(3);
    expect(replan.qa_required).toBe(false);

    const [workspace] = await sql`
      SELECT worktree_path, branch_name, reused
      FROM task_workspaces
      WHERE task_id = (
        SELECT id FROM tasks WHERE parent_task_id = ${task.id} AND assigned_to = 'goal-supervisor'
      )
    `;
    expect(workspace.worktree_path).toBe("/repo/base/.claude/worktrees/qa-cap");
    expect(workspace.branch_name).toBe("hw/task/qa-cap");
    expect(workspace.reused).toBe(true);

    const [candidate] = await sql<{ role_slug: string; slug: string; evidence: unknown[] | string }[]>`
      SELECT role_slug, slug, evidence
      FROM skill_drafts
      WHERE hive_id = ${bizId}
        AND role_slug = 'qa-test-role'
    `;
    const evidence = typeof candidate.evidence === "string"
      ? JSON.parse(candidate.evidence) as unknown[]
      : candidate.evidence;
    expect(candidate.role_slug).toBe("qa-test-role");
    expect(candidate.slug).toBe("qa-test-role-qa-failure-skill-improvement");
    expect(evidence).toHaveLength(1);
    expect(JSON.stringify(evidence)).toContain("Goal QA failure");
  });

  it("blocks goal-task QA cap replan when the task family replacement budget is exhausted", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${bizId}, 'Goal QA Budget', 'Goal task budget test', 'active')
      RETURNING *
    `;

    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, goal_id, assigned_to, created_by, title, brief, status,
        retry_count, sprint_number
      )
      VALUES (
        ${bizId},
        ${goal.id},
        'qa-test-role',
        'goal-supervisor',
        'goal qa budget task',
        'Do goal work',
        'in_review',
        2,
        3
      )
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES
        (${bizId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'replacement one', 'retry', 'failed', ${task.id}),
        (${bizId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'replacement two', 'retry', 'failed', ${task.id}),
        (${bizId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'replacement three', 'retry', 'failed', ${task.id})
    `;

    await processQaResult(sql, task.id, { passed: false, feedback: "Still failing QA" });

    const [updated] = await sql`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toContain("Recovery budget exhausted");
    expect(updated.failure_reason).toContain("replacement tasks 4/3");

    const replanRows = await sql`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${task.id}
        AND assigned_to = 'goal-supervisor'
        AND title LIKE '[Replan] QA failed repeatedly:%'
    `;
    expect(replanRows).toHaveLength(0);
  });

  it("counts dispatcher-created QA replan tasks against the replacement budget", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${bizId}, 'Goal QA Replan Count', 'Goal task budget count test', 'active')
      RETURNING *
    `;

    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, goal_id, assigned_to, created_by, title, brief, status,
        retry_count, sprint_number
      )
      VALUES (
        ${bizId},
        ${goal.id},
        'qa-test-role',
        'goal-supervisor',
        'goal qa replan count task',
        'Do goal work',
        'failed',
        2,
        3
      )
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES
        (${bizId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'replacement one', 'retry', 'failed', ${task.id}),
        (${bizId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'replacement two', 'retry', 'failed', ${task.id}),
        (${bizId}, ${goal.id}, 'goal-supervisor', 'dispatcher', '[Replan] QA failed repeatedly: prior failure', 'replan', 'completed', ${task.id})
    `;

    await notifyGoalSupervisorOfQaFailure(sql, task.id, "Another QA failure");

    const [updated] = await sql`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toContain("replacement tasks 4/3");
  });

  it("blocks duplicate direct-task QA cap decisions for the same task family", async () => {
    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status,
        retry_count, result_summary
      )
      VALUES (
        ${bizId},
        'qa-test-role',
        'owner',
        'direct duplicate qa cap task',
        'Do direct work',
        'in_review',
        2,
        'Latest task summary'
      )
      RETURNING *
    `;

    await sql`
      INSERT INTO decisions (hive_id, task_id, title, context, priority, status, kind)
      VALUES (${bizId}, ${task.id}, 'Existing QA recovery decision', 'Already needs a decision', 'urgent', 'ea_review', 'decision')
    `;

    await processQaResult(sql, task.id, { passed: false, feedback: "Still failing QA" });

    const rows = await sql`
      SELECT id
      FROM decisions
      WHERE task_id = ${task.id}
    `;
    expect(rows).toHaveLength(1);

    const [updated] = await sql`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toContain("open recovery decisions");
  });

  it("deduplicates repeated QA cap failures for the same role into one skill candidate", async () => {
    for (const title of ["first repeated qa cap", "second repeated qa cap"]) {
      const [task] = await sql`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, title, brief, status,
          retry_count, result_summary
        )
        VALUES (
          ${bizId},
          'qa-test-role',
          'owner',
          ${title},
          'Do direct work',
          'in_review',
          2,
          'Latest task summary'
        )
        RETURNING *
      `;

      await processQaResult(sql, task.id, { passed: false, feedback: `${title} feedback` });
    }

    const rows = await sql<{ id: string; evidence: unknown[] | string }[]>`
      SELECT id, evidence
      FROM skill_drafts
      WHERE hive_id = ${bizId}
        AND role_slug = 'qa-test-role'
        AND slug = 'qa-test-role-qa-failure-skill-improvement'
    `;
    const evidence = typeof rows[0].evidence === "string"
      ? JSON.parse(rows[0].evidence) as unknown[]
      : rows[0].evidence;
    expect(rows).toHaveLength(1);
    expect(evidence).toHaveLength(2);
  });
});
