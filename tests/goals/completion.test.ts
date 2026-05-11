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
      ('doctor', 'Doctor', 'executor', 'claude-code'),
      ('qa', 'QA', 'executor', 'claude-code')
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
      learningGate: {
        category: "memory",
        rationale: "The owner's launch preference should be retained for future goals.",
        action: "Save the launch preference as hive memory.",
      },
    });

    const completions = await sql`
      SELECT id, goal_id, summary, evidence, learning_gate, created_by FROM goal_completions
      WHERE goal_id = ${goalId}
    `;
    expect(completions.length).toBe(1);
    expect(completions[0].summary).toBe("goalcomp: shipped with evidence");
    expect(completions[0].created_by).toBe("goal-supervisor");
    expect(completions[0].evidence).toEqual({ taskIds: [taskId] });
    expect(completions[0].learning_gate).toEqual({
      category: "memory",
      rationale: "The owner's launch preference should be retained for future goals.",
      action: "Save the launch preference as hive memory.",
    });
  });

  it("persists a lightweight evidence bundle alongside existing evidence IDs", async () => {
    const taskId = (await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'goalcomp-role', 'system', 'goalcomp-bundle-task', 'evidence task', ${goalId})
      RETURNING id
    `)[0].id;
    const evidenceBundle = [
      {
        type: "artifact",
        description: "The shipped artifact is available in the workspace.",
        reference: "docs/release-notes.md",
        verified: true,
      },
      {
        type: "test",
        description: "Focused completion tests passed.",
        value: "vitest tests/goals/completion.test.ts",
      },
    ];

    await completeGoal(sql, goalId, "goalcomp: shipped with evidence bundle", {
      evidenceTaskIds: [taskId],
      evidenceBundle,
    });

    const [completion] = await sql<{ evidence: unknown }[]>`
      SELECT evidence FROM goal_completions WHERE goal_id = ${goalId}
    `;
    expect(completion.evidence).toEqual({
      taskIds: [taskId],
      bundle: evidenceBundle,
    });
  });

  it("defaults createdBy to 'goal-supervisor' and records a no-op learning gate when omitted", async () => {
    await completeGoal(sql, goalId, "goalcomp: minimal call");

    const completions = await sql`
      SELECT created_by, evidence, learning_gate FROM goal_completions WHERE goal_id = ${goalId}
    `;
    expect(completions.length).toBe(1);
    expect(completions[0].created_by).toBe("goal-supervisor");
    expect(completions[0].evidence).toEqual({});
    expect(completions[0].learning_gate).toEqual({
      category: "nothing",
      rationale: "No reusable learning gate result was supplied.",
    });
  });

  it("does not create learning follow-up artifacts for a no-op learning gate", async () => {
    await completeGoal(sql, goalId, "goalcomp: no reusable learning", {
      learningGate: {
        category: "nothing",
        rationale: "The work was one-off and produced no reusable improvement.",
      },
    });

    const [decisionCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM decisions WHERE hive_id = ${bizId}
    `;
    const [skillDraftCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM skill_drafts WHERE hive_id = ${bizId}
    `;
    const [standingInstructionCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM standing_instructions WHERE hive_id = ${bizId}
    `;
    const [pipelineTemplateCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pipeline_templates WHERE hive_id = ${bizId}
    `;

    expect(decisionCount.count).toBe(0);
    expect(skillDraftCount.count).toBe(0);
    expect(standingInstructionCount.count).toBe(0);
    expect(pipelineTemplateCount.count).toBe(0);
  });

  it("records a bounded hive memory follow-up for memory learning gates", async () => {
    await completeGoal(sql, goalId, "goalcomp: learned owner preference", {
      learningGate: {
        category: "memory",
        rationale: "Future launches should remember the owner prefers concise launch reports.",
        action: "Remember that launch reports should be concise and lead with verification evidence.",
      },
    });

    const memories = await sql<{ category: string; content: string; sensitivity: string }[]>`
      SELECT category, content, sensitivity
      FROM hive_memory
      WHERE hive_id = ${bizId}
        AND content ILIKE '%Learning gate memory%'
    `;
    expect(memories).toHaveLength(1);
    expect(memories[0].category).toBe("learning");
    expect(memories[0].sensitivity).toBe("internal");
    expect(memories[0].content).toContain("concise launch reports");
    expect(memories[0].content.length).toBeLessThanOrEqual(1200);

    const [standingInstructionCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM standing_instructions WHERE hive_id = ${bizId}
    `;
    expect(standingInstructionCount.count).toBe(0);
  });

  it("creates a governed skill draft for skill learning gates", async () => {
    await completeGoal(sql, goalId, "goalcomp: reusable procedure found", {
      learningGate: {
        category: "skill",
        rationale: "The supervisor found a repeatable verification pattern for future goals.",
        action: "Draft a reusable skill for evidence-first goal verification.",
      },
    });

    const [draft] = await sql<{
      role_slug: string;
      slug: string;
      content: string;
      scope: string;
      status: string;
      evidence: unknown[] | string;
    }[]>`
      SELECT role_slug, slug, content, scope, status, evidence
      FROM skill_drafts
      WHERE hive_id = ${bizId}
    `;
    expect(draft.role_slug).toBe("goal-supervisor");
    expect(draft.slug).toBe("goalcomp-goal-learning-gate-skill");
    expect(draft.scope).toBe("hive");
    expect(draft.status).toBe("pending");
    expect(draft.content).toContain("evidence-first goal verification");
    const evidence = typeof draft.evidence === "string" ? JSON.parse(draft.evidence) : draft.evidence;
    expect(evidence[0]).toMatchObject({
      type: "manual",
      summary: expect.stringContaining("repeatable verification pattern"),
      source: "goal-learning-gate",
    });

    const [qaTaskCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE hive_id = ${bizId}
        AND assigned_to = 'qa'
        AND title = '[Skill QA] Review: goalcomp-goal-learning-gate-skill'
    `;
    expect(qaTaskCount.count).toBe(1);
  });

  it("creates owner-review decisions for reusable candidates without activating mandatory changes", async () => {
    for (const [index, category] of (["template", "policy_candidate", "pipeline_candidate", "update_existing"] as const).entries()) {
      const [goal] = await sql<{ id: string }[]>`
        INSERT INTO goals (hive_id, title, status, budget_cents, spent_cents, session_id)
        VALUES (${bizId}, ${`goalcomp-followup-${index}`}, 'active', 5000, 2500, ${`gs-followup-${index}`})
        RETURNING id
      `;

      await completeGoal(sql, goal.id, `goalcomp: completed ${category}`, {
        learningGate: {
          category,
          rationale: `${category} rationale should be reviewed before changing future behavior.`,
          action: `${category} action recommendation for owner review.`,
        },
      });
    }

    const decisions = await sql<{
      title: string;
      context: string;
      recommendation: string | null;
      status: string;
      priority: string;
      kind: string;
      options: unknown;
    }[]>`
      SELECT title, context, recommendation, status, priority, kind, options
      FROM decisions
      WHERE hive_id = ${bizId}
      ORDER BY created_at ASC
    `;

    expect(decisions).toHaveLength(4);
    expect(decisions.map((decision) => decision.status)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(decisions.map((decision) => decision.kind)).toEqual([
      "learning_gate_followup",
      "learning_gate_followup",
      "learning_gate_followup",
      "learning_gate_followup",
    ]);
    expect(decisions[0].title).toContain("Template");
    expect(decisions[0].context).toContain("requires review before it is saved as reusable structure");
    expect(decisions[1].title).toContain("Policy candidate");
    expect(decisions[1].context).toContain("requires owner review before becoming a standing instruction, rule, or mandatory policy");
    expect(decisions[2].title).toContain("Pipeline candidate");
    expect(decisions[2].context).toContain("requires owner review before any pipeline is activated or made mandatory");
    expect(decisions[3].title).toContain("Update existing");
    expect(decisions[3].context).toContain("review before updating existing reusable behavior");
    expect(decisions[3].recommendation).toContain("update_existing action recommendation");

    const [standingInstructionCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM standing_instructions WHERE hive_id = ${bizId}
    `;
    const [pipelineTemplateCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pipeline_templates WHERE hive_id = ${bizId}
    `;
    const [pipelineRunCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pipeline_runs WHERE hive_id = ${bizId}
    `;
    expect(standingInstructionCount.count).toBe(0);
    expect(pipelineTemplateCount.count).toBe(0);
    expect(pipelineRunCount.count).toBe(0);
  });

  it("does not duplicate completion records, memory, or follow-ups when called again directly", async () => {
    await completeGoal(sql, goalId, "goalcomp duplicate: first completion", {
      learningGate: {
        category: "template",
        rationale: "This reusable template should be owner-reviewed once.",
        action: "Create one reusable launch checklist template.",
      },
    });
    await completeGoal(sql, goalId, "goalcomp duplicate: second completion", {
      learningGate: {
        category: "template",
        rationale: "This repeated call should not create more records.",
        action: "Create another template.",
      },
    });

    const [goal] = await sql<{ status: string }[]>`
      SELECT status FROM goals WHERE id = ${goalId}
    `;
    expect(goal.status).toBe("achieved");

    const completions = await sql<{ summary: string }[]>`
      SELECT summary FROM goal_completions WHERE goal_id = ${goalId}
    `;
    expect(completions).toHaveLength(1);
    expect(completions[0].summary).toBe("goalcomp duplicate: first completion");

    const memories = await sql`
      SELECT id FROM hive_memory
      WHERE hive_id = ${bizId}
        AND content LIKE '%goalcomp duplicate:%'
    `;
    expect(memories).toHaveLength(1);

    const followups = await sql`
      SELECT id FROM decisions
      WHERE hive_id = ${bizId}
        AND kind = 'learning_gate_followup'
    `;
    expect(followups).toHaveLength(1);
  });

  it("bounds learning follow-up decision titles for very long goal titles", async () => {
    const longTitle = "G".repeat(500);
    await sql`
      UPDATE goals
      SET title = ${longTitle}
      WHERE id = ${goalId}
    `;

    await expect(completeGoal(sql, goalId, "goalcomp: long title completed", {
      learningGate: {
        category: "template",
        rationale: "The template should be reviewed even when the goal title is long.",
        action: "Create a reusable template from this goal.",
      },
    })).resolves.toBeUndefined();

    const [decision] = await sql<{ title: string }[]>`
      SELECT title
      FROM decisions
      WHERE goal_id = ${goalId}
        AND kind = 'learning_gate_followup'
    `;
    expect(decision.title.length).toBeLessThanOrEqual(500);
    expect(decision.title).toContain("Template");
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
