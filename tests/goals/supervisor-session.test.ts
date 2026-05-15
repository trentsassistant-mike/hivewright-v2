import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCommentWakeUpPrompt,
  buildSupervisorInitialPrompt,
  buildSprintWakeUpPrompt,
} from "@/goals/supervisor-session";
import { upsertGoalPlan } from "@/goals/goal-documents";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('supsess-biz', 'SupSess Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id as string;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('suptool-role', 'SupTool Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  // Set a dummy session_id so the running dispatcher's findNewGoals query
  // (which filters WHERE session_id IS NULL) ignores this test fixture.
  // Without this, a live dispatcher races the test and creates real tasks
  // against our goal, breaking cleanup.
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, description, status, budget_cents, session_id)
    VALUES (${bizId}, 'supsess-goal', 'ship a feature', 'active', 5000, 'gs-supsess-test-fixture')
    RETURNING *
  `;
  goalId = goal.id as string;
});

describe("buildSupervisorInitialPrompt", () => {
  it("instructs the supervisor to create a plan BEFORE execution tasks", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt.toLowerCase()).toContain("create_goal_plan");
    expect(prompt.toLowerCase()).toMatch(/before.*(creat|execut).*task/);
  });

  it("lists required plan sections", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toMatch(/Goal Summary/);
    expect(prompt).toMatch(/Success Criteria/);
    expect(prompt).toMatch(/Risks/);
    expect(prompt).toMatch(/Workstreams/);
    expect(prompt).toMatch(/Evidence Required/);
  });

  it("requires acceptance criteria on implementation tasks", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt.toLowerCase()).toContain("acceptance criteria");
  });

  it("does not require git commits for non-repository goals", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("Workspace finalization (non-repository by default)");
    expect(prompt).toContain("Do NOT require child agents to create git branches, worktrees, or commits");
    expect(prompt).toContain("## Final Step — Evidence");
    expect(prompt).not.toContain("## Final Step — Commit");
  });

  it("requires commit discipline only for goals tied to git-backed projects", async () => {
    const [project] = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path, git_repo)
      VALUES (${bizId}, 'repo-project', 'Repo Project', '/tmp/repo-project', true)
      RETURNING id
    `;
    await sql`UPDATE goals SET project_id = ${project.id} WHERE id = ${goalId}`;

    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("Repository finalization (MANDATORY for git-backed project tasks)");
    expect(prompt).toContain("## Final Step — Commit");
    expect(prompt.toLowerCase()).toMatch(/git (add|commit)/);
  });

  it("frames supervisors as outcome owners with outcome-led and process-bound modes", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("outcome owner");
    expect(prompt).toContain("outcome-led");
    expect(prompt).toContain("process-bound");
    expect(prompt).toMatch(/owner-defined.*(process|rules|policies)/i);
  });

  it("treats a broad owner request as an outcome plan, not a lazy single task", async () => {
    await sql`
      UPDATE goals
      SET title = 'I want a website for HiveWright',
          description = 'Broad owner outcome without predefined steps.'
      WHERE id = ${goalId}
    `;

    const prompt = await buildSupervisorInitialPrompt(sql, goalId);

    expect(prompt).toContain("I want a website for HiveWright");
    expect(prompt).toMatch(/single owner outcome/i);
    expect(prompt).toMatch(/Desired Outcome/);
    expect(prompt).toMatch(/Professional Process Inferred/);
    expect(prompt).toMatch(/BEFORE creating any execution tasks/);
    expect(prompt).not.toMatch(/create (a )?single task/i);
  });

  it("tells supervisors to apply owner procedures from hive context before inferring workflow", async () => {
    await sql`
      INSERT INTO standing_instructions (hive_id, content, affected_departments, confidence)
      VALUES (${bizId}, 'Never publish customer-facing marketing copy without owner approval.', '[]'::jsonb, 0.98)
    `;

    const prompt = await buildSupervisorInitialPrompt(sql, goalId);

    expect(prompt).toContain("**Policies / Rules / Owner Procedures:**");
    expect(prompt).toContain("- [standing instruction] Never publish customer-facing marketing copy without owner approval.");
    expect(prompt).toMatch(/owner-approved procedures\/rules in the Hive Context override agent judgment when applicable/i);
    expect(prompt).toMatch(/check the Policies \/ Rules \/ Owner Procedures context before inferring a professional workflow/i);
  });

  it("uses pipelines selectively for mandatory or approved process-bound work", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("list_pipeline_templates");
    expect(prompt).toContain("start_pipeline_run");
    expect(prompt).toContain("propose_pipeline_template");
    expect(prompt).toMatch(/mandatory owner process|owner-approved process|process-bound/i);
    expect(prompt).not.toContain("Pipeline-first route selection");
  });

  it("requires learning gate review before marking an outcome achieved", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("Learning Gate");
    expect(prompt).toMatch(/memory|skill|template|policy|pipeline/i);
    expect(prompt).toMatch(/owner approval.*mandatory/i);
  });

  it("prefers content-publishing pipeline for repeatable content goals", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("content-publishing");
    expect(prompt).toMatch(/blog|social|newsletter|repeatable content/i);
    expect(prompt).toContain("slug='content-publishing'");
  });

  it("carries the HiveWright product copy guard into content goals", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toContain("HiveWright Product Copy Guard");
    expect(prompt).toContain("Do NOT introduce");
    expect(prompt).toContain("AI pilot");
    expect(prompt).toContain("controlled autonomy");
    expect(prompt).toContain("AI spend budget");
  });

  it("states allowed fallback reasons when direct tasks are used for content goals", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toMatch(/single.shot/i);
    expect(prompt).toMatch(/manual external publish/i);
    expect(prompt).toMatch(/Fallback Reason/);
  });

  it("states that Publish / Handoff does not close the parent goal", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toMatch(/Publish \/ Handoff.*NOT.*goal/i);
    expect(prompt).toMatch(/publish.handoff.*terminal.*pipeline run only/i);
  });

  it("requires downstream evidence before content goal closure", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt).toMatch(/channel handoff/i);
    expect(prompt).toMatch(/Discord.*owner notification|owner notification.*Discord/i);
    expect(prompt).toMatch(/QA.*verification|verification.*QA/i);
    expect(prompt).toContain("publish_ready_package");
    expect(prompt).toContain("published_verified");
  });

  it("keeps publication-or-file-output goals open when no live artifact exists", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt.toLowerCase()).toMatch(
      /no live artifact when publication or (a )?file output was required/,
    );
  });

  it("allows direct-fallback follow-up confirmations to be explicitly marked not required", async () => {
    const prompt = await buildSupervisorInitialPrompt(sql, goalId);
    expect(prompt.toLowerCase()).toMatch(/explicitly marks? .*not required/);
  });
});

describe("buildSprintWakeUpPrompt", () => {
  it("includes a plan summary when a plan exists", async () => {
    await upsertGoalPlan(sql, goalId, {
      title: "supsess-plan",
      body: "# Goal Summary\nShip it\n## Success Criteria\n- feature renders",
      createdBy: "goal-supervisor",
    });
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-done', 'b', ${goalId}, 1, 'completed')
    `;
    const prompt = await buildSprintWakeUpPrompt(sql, goalId, 1);
    expect(prompt.toLowerCase()).toContain("plan");
    expect(prompt).toContain("supsess-plan");
  });

  it("shows explicit cancelled handling instructions when cancelled tasks exist", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-ok', 'b', ${goalId}, 1, 'completed'),
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-gone', 'b', ${goalId}, 1, 'cancelled')
    `;
    const prompt = await buildSprintWakeUpPrompt(sql, goalId, 1);
    expect(prompt).toMatch(/Cancelled Tasks/);
    // Must tell supervisor to explicitly handle cancellations, not ignore them
    expect(prompt.toLowerCase()).toMatch(/cancell[\s\S]*(retry|replan|reason|decide|explain)/);
  });

  it("does not treat cancelled tasks as successful progress", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-c1', 'b', ${goalId}, 1, 'cancelled'),
        (${bizId}, 'suptool-role', 'goal-supervisor', 'supsess-c2', 'b', ${goalId}, 1, 'cancelled')
    `;
    const prompt = await buildSprintWakeUpPrompt(sql, goalId, 1);
    // Should NOT claim the sprint is "complete" with zero completed tasks
    expect(prompt).not.toMatch(/sprint.*(complete|succeeded|done)/i);
  });
});

describe("buildCommentWakeUpPrompt", () => {
  it("shows the current completion payload shape when owner says the goal is resolved", async () => {
    const [comment] = await sql<{ id: string }[]>`
      INSERT INTO goal_comments (goal_id, body, created_by)
      VALUES (${goalId}, 'This should be resolved now.', 'owner')
      RETURNING id
    `;

    const prompt = await buildCommentWakeUpPrompt(sql, goalId, comment.id);

    expect(prompt).toContain(`POST http://localhost:3002/api/goals/${goalId}/complete`);
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"evidenceTaskIds"');
    expect(prompt).toContain('"evidenceWorkProductIds"');
    expect(prompt).toContain('"evidence"');
    expect(prompt).toContain('"learningGate"');
    expect(prompt).toContain('"category":"nothing"');
    expect(prompt).toContain('"rationale"');
  });
});
