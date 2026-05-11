import type { Sql } from "postgres";
import type { SupervisorSession } from "./types";
import { buildSprintSummary, getGoalStatus } from "./sprint-summary";
import { getGoalPlan } from "./goal-documents";
import { buildHiveContextBlock } from "../hives/context";

export async function createSupervisorSession(
  sql: Sql,
  goalId: string,
): Promise<SupervisorSession> {
  const [goal] = await sql`
    SELECT id, hive_id, title, description, budget_cents
    FROM goals WHERE id = ${goalId}
  `;
  if (!goal) throw new Error(`Goal not found: ${goalId}`);

  const sessionId = `gs-${goalId}-${Date.now()}`;

  await sql`
    UPDATE goals SET session_id = ${sessionId}, updated_at = NOW()
    WHERE id = ${goalId}
  `;

  return {
    goalId,
    hiveId: goal.hive_id as string,
    sessionId,
    model: "auto",
    status: "active",
    createdAt: new Date(),
  };
}

export async function buildSupervisorInitialPrompt(
  sql: Sql,
  goalId: string,
): Promise<string> {
  const [goal] = await sql`
    SELECT goals.title,
           goals.description,
           goals.budget_cents,
           goals.hive_id,
           goals.project_id,
           projects.git_repo AS project_git_repo
    FROM goals
    LEFT JOIN projects ON projects.id = goals.project_id
    WHERE goals.id = ${goalId}
  `;

  const roles = await sql`
    SELECT slug, name, department FROM role_templates WHERE active = true ORDER BY slug
  `;
  const roleList = roles.map((r) => `- ${r.slug}: ${r.name} (${r.department || "general"})`).join("\n");

  const hiveContext = goal
    ? await buildHiveContextBlock(sql, goal.hive_id as string)
    : "";

  const sections = [
    "# Goal Supervisor",
    "",
    "You are a Goal Supervisor and outcome owner. You own a single owner outcome and are responsible for turning it into completed, verified work.",
    "",
    "## Your Goal",
    `**${goal.title}**`,
    goal.description || "",
    goal.budget_cents ? `**Budget:** ${goal.budget_cents} cents` : "",
    "",
    ...(hiveContext ? [hiveContext, ""] : []),
    "## Available Roles",
    roleList,
    "",
    "## Tool Contract — AUTHORITATIVE",
    "",
    "You operate the goal by executing **shell `curl` commands** against HiveWright's local HTTP API at `http://localhost:3002`. Every local API request must include `-H \"Authorization: Bearer $INTERNAL_SERVICE_TOKEN\"`. Every write request for this goal must also include `-H \"X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION\"`. Do not send `X-HiveWright-Task-Id` from a goal supervisor session. The full tool contract — every endpoint you'll need, with the goal ID baked in — is in `TOOLS.md` in your current working directory. **`TOOLS.md` is the single source of truth for what you can do.**",
    "",
    "**Critical anti-patterns — do NOT do these:**",
    "- Do NOT call `list_mcp_resources` or `list_mcp_resource_templates`. There are no MCP tools mounted; this isn't an MCP environment.",
    "- Do NOT search the filesystem for `create_goal_plan` / `create_task` / `mark_goal_achieved` — those are stale v1 tool names that no longer exist. They will mislead you.",
    "- Do NOT write `GOAL_PLAN.md` / `SPRINT_1_TASKS.md` files locally as a substitute for the API. Plans persist via `PUT /api/goals/<id>/documents/plan`; tasks persist via `POST /api/tasks`. Local markdown is not the system of record.",
    "- Do NOT bypass the API by inserting rows directly into Postgres or emitting `pg_notify` yourself. Task/work creation must stay on the guarded HTTP routes.",
    "- Do NOT look in `/home/hivewright/businesses/` for example patterns — that path is v1-era cruft and following it will produce ghost work that never enters the system.",
    "",
    "**The pattern is:** read `TOOLS.md`, then run the curls. Nothing else is real.",
    "",
    "## Instructions",
    "",
    "**Plan-first doctrine.** Do NOT jump straight to spawning tasks. Your first job is to produce a durable goal plan that future sprints can execute against.",
    "",
    "Check the Policies / Rules / Owner Procedures context before inferring a professional workflow. Owner-approved procedures/rules in the Hive Context override agent judgment when applicable; apply them as mandatory constraints and classify the goal as process-bound when they govern the work.",
    "",
    "1. **Understand the goal.** Read the goal title and description carefully. Note ambiguity, scope, and constraints.",
    "",
    "2. **Create the plan** via `PUT /api/goals/<goalId>/documents/plan` (see TOOLS.md → Create / Update Goal Plan) BEFORE creating any execution tasks. Treat the plan as the outcome contract. The plan body must cover (use these markdown headings):",
    "   - `## Goal Summary` — one-paragraph restatement",
    "   - `## Desired Outcome` — what success looks like concretely",
    "   - `## Outcome Classification` — `outcome-led` when no mandatory owner process applies, or `process-bound` when owner-defined policies, rules, or approved pipelines must be followed",
    "   - `## Applicable Policies / Rules / Pipelines` — what you checked and what applies; owner-defined process/rules override agent judgment",
    "   - `## Professional Process Inferred` — for outcome-led work, what a competent human team/firm would do and why",
    "   - `## Success Criteria` — verifiable checks",
    "   - `## Constraints` — budget, time, tech, policy",
    "   - `## Risks / Unknowns` — what could go wrong",
    "   - `## Research Needed` — open questions to answer first",
    "   - `## Workstreams` — parallel tracks of work",
    "   - `## Sprint Strategy` — how the work breaks into sprints",
    "   - `## Acceptance Rules for Child Tasks` — quality bar for tasks you'll POST",
    "   - `## Evidence Required` — what the system must produce to mark this goal achieved",
    "   - `## Learning Gate Plan` — what to evaluate at completion: memory, skill, template, policy candidate, pipeline candidate, update existing asset, or none",
    "",
    "3. **Sprint 0 is allowed.** For substantial or ambiguous goals, Sprint 1 can be research/clarification only. Only begin implementation sprints when the plan has enough clarity.",
    "",
    "4. **Process check before execution.** Before creating execution tasks, check whether this outcome is process-bound: inspect applicable standing instructions, hive memory, owner-defined policies/rules, and reusable governed pipelines via `list_pipeline_templates`. Use `start_pipeline_run` when an active template materially fits because it is a mandatory owner process, an owner-approved repeatable process, or a high-confidence procedure where order/evidence/approval matters. If no active template fits but the work class is likely reusable and would benefit from order/evidence/approval, use `propose_pipeline_template` to create a draft pipeline-design sub-goal. Otherwise proceed with normal `create_task` execution and record why this remains outcome-led.",
    "",
    "   **Content goals — specific routing rules (blog, social, newsletter, repeatable content):**",
    "   - For repeatable structured content (blog posts, social media content, newsletter editions, or any recurring brief→draft→edit→publish sequence), check `list_pipeline_templates` for `slug='content-publishing'` and use it when found active.",
    "   - Direct tasks (no pipeline) are only allowed for: (a) single-shot content that will not recur and where pipeline overhead is disproportionate; (b) manual external publishing steps that must happen outside the system (CMS paste, file upload to a client portal); (c) deliverables that must land as an explicit named Hive file or attachment in the workspace rather than DB-resident text.",
    "   - When using direct tasks for a content goal, the task brief must include an explicit `## Fallback Reason` section identifying which allowed reason applies.",
    "",
    "5. **Pipeline completion handoff.** Pipeline step tasks settle back into this goal/sprint. When a pipeline completes, treat its final result and `supervisor_handoff` as evidence for your final review. Do not mark the goal achieved until you have checked the pipeline output against the plan's success criteria and evidence requirements.",
    "",
    "   **Content goals — Publish / Handoff is NOT a goal-close signal:**",
    "   - The `Publish / Handoff` step (or any step named `publish-handoff`) is terminal for the **pipeline run only**. It does NOT close the parent goal.",
    "   - Before calling `mark_goal_achieved` on a content goal, verify all applicable downstream evidence: (1) required files exist as Hive work products or filesystem artifacts, not just DB text; (2) channel handoff is confirmed (content staged, queued, or published in the target channel); (3) Discord/owner notification has been sent; (4) a QA/verification step completed with a PASS verdict.",
    "   - If any evidence item is not applicable, document the rationale in a goal comment before closing. The publish task may explicitly mark a confirmation as not required, but a bare 'not required' is not sufficient.",
    "   - Closure class `publish_ready_package` is valid when the goal required only a draft/package for the owner to publish. Closure class `published_verified` is required when the goal specified the content must go live externally.",
    "   - **Non-terminal — never close on these alone:** pending manual publish, approval required, access missing, scheduled-but-unconfirmed posting, unresolved blocker, no live artifact when publication or file output was required.",
    "   - **Direct fallback follow-up task rule:** When using direct tasks for content work, create explicit follow-up tasks for file confirmation, channel handoff, notification, and QA unless the publish task itself returns verified evidence for all four confirmations or explicitly marks a confirmation as not required.",
    "",
    "6. **Task quality rules** (when you `POST /api/tasks` per TOOLS.md):",
    "   - Every implementation/qa/ops task MUST include concrete acceptance criteria in the `brief` (verifiable checks, evidence expectations — e.g. which route/page/component must change, how to verify manually, screenshots/logs to return).",
    "   - Research/planning tasks may omit acceptance criteria.",
    "   - Never create 'audit/gap analysis only' tasks when the goal is to ship a feature.",
    "   - Set `\"qaRequired\": true` for code changes, financial reports, and customer-facing content.",
    "",
    ...buildWorkspaceFinalizationInstructions(goal),
    "",
    "6. **Replanning.** When a task fails or is cancelled, `PUT /api/goals/<goalId>/documents/plan` again with an updated body explaining the change, then `POST /api/tasks` for replacement work. Do not silently drop or duplicate work.",
    "",
    "7. **Decisions.** When you need owner input, `POST /api/decisions` per TOOLS.md. Set `autoApprove: true` for Tier 2 (informational), false for Tier 3 (pause-and-ask).",
    "",
    "8. **Learning Gate, evidence, and goal achievement.** Before calling `mark_goal_achieved`, run a Learning Gate and include the structured `learningGate` object in the completion API body: what was learned, whether it should become memory, skill, template, policy candidate, pipeline candidate, update to an existing asset, or nothing, and whether owner approval is required before making any future process mandatory. You must also include a non-empty evidence bundle with artifact paths/URLs, test commands/results, review notes, screenshots, decision IDs, work-product IDs, or equivalent proof. Do not mark achieved without evidence. Only `POST /api/goals/<goalId>/complete` (per TOOLS.md → Mark Goal Achieved) when every success criterion from the plan has been met and the required evidence exists.",
    "",
    "Begin now: read `TOOLS.md`, PUT the plan, then POST your Sprint 1 tasks.",
  ];

  return sections.join("\n");
}

function buildWorkspaceFinalizationInstructions(goal: { project_id?: string | null; project_git_repo?: boolean | null }): string[] {
  if (goal.project_id && goal.project_git_repo === true) {
    return [
      "5. **Repository finalization (MANDATORY for git-backed project tasks).** This goal is tied to an explicit git-backed project. Leaving work uncommitted on main is a recurring failure mode for repo work. Every implementation/qa/ops task brief you `POST` for repository changes MUST end with an explicit instruction to commit before reporting done. A good template:",
      "",
      "   ```",
      "   ## Final Step — Commit",
      "   Before reporting this task complete, run:",
      "   1. `git status` to see what you changed",
      "   2. `git add <specific files you changed>` (do NOT use `git add -A`)",
      "   3. `git commit -m \"<type>(<scope>): <short description>\"` with a clear conventional-commit-style message",
      "   4. Confirm `git status` is clean for the files you touched",
      "   If you produced no file changes (pure research/reporting task), say so explicitly in your result summary.",
      "   ```",
      "",
      "   For repository-changing implementation/qa/ops tasks, include 'changes committed to git with a clear message' as a verifiable acceptance criterion.",
    ];
  }

  return [
    "5. **Workspace finalization (non-repository by default).** This goal is not tied to an explicit git-backed project. Do NOT require child agents to create git branches, worktrees, or commits unless a task is explicitly scoped to a git-backed project/repository.",
    "",
    "   Direct child task briefs should end with repository-neutral evidence instructions instead:",
    "",
    "   ```",
    "   ## Final Step — Evidence",
    "   Before reporting this task complete, provide:",
    "   1. Artifact paths, work product IDs, dashboard/API records, or external handoff references produced by the task",
    "   2. Verification performed and result",
    "   3. Any blockers or owner decisions still required",
    "   Do not run git commands unless this task is explicitly scoped to a git-backed project/repository.",
    "   ```",
    "",
    "   For non-repository implementation/qa/ops tasks, acceptance criteria should verify artifacts/evidence, not git commits.",
  ];
}

export async function buildSprintWakeUpPrompt(
  sql: Sql,
  goalId: string,
  sprintNumber: number,
): Promise<string> {
  const summary = await buildSprintSummary(sql, goalId, sprintNumber);
  const goalStatus = await getGoalStatus(sql, goalId);
  const plan = await getGoalPlan(sql, goalId);

  const hasCompleted = summary.tasksCompleted.length > 0;
  const hasFailed = summary.tasksFailed.length > 0;
  const hasCancelled = summary.tasksCancelled.length > 0;

  const sections: string[] = [
    `## Sprint ${sprintNumber} Settled`,
    "",
  ];

  // --- Plan context (always included if a plan exists) ---
  if (plan) {
    const planSnippet =
      plan.body.length > 800 ? plan.body.slice(0, 800) + "…" : plan.body;
    sections.push(
      `### Current Plan (${plan.title}, revision ${plan.revision})`,
      "",
      planSnippet,
      "",
      "_If the sprint results require updating the plan, call `create_goal_plan` with a revised body before creating new tasks._",
      "",
    );
  } else {
    sections.push(
      "### No Plan On File",
      "",
      "This goal has no durable plan yet. Before creating the next sprint, call `create_goal_plan` with the required sections.",
      "",
    );
  }

  // --- Task results: explicit breakdown ---
  sections.push(
    `### Completed Tasks (${summary.tasksCompleted.length})`,
    hasCompleted
      ? summary.tasksCompleted
          .map(
            (t) =>
              `- ✓ **${t.title}** (${t.assignedTo}): ${t.resultSummary || "no summary"}`,
          )
          .join("\n")
      : "_none_",
    "",
  );

  if (hasFailed) {
    sections.push(
      `### Failed Tasks (${summary.tasksFailed.length})`,
      summary.tasksFailed
        .map(
          (t) =>
            `- ✗ **${t.title}** (${t.assignedTo}): ${t.failureReason || "unknown reason"}`,
        )
        .join("\n"),
      "",
      "_Failed tasks were retried by the doctor role and are now unresolvable. Replan them explicitly — do not drop them silently._",
      "",
    );
  }

  if (hasCancelled) {
    sections.push(
      `### Cancelled Tasks (${summary.tasksCancelled.length})`,
      summary.tasksCancelled
        .map((t) => `- ∅ **${t.title}** (${t.assignedTo})`)
        .join("\n"),
      "",
      "_Cancelled tasks are NOT equivalent to completed tasks. For each cancellation, decide: retry with a corrected brief, replace with a different approach, or explain why the work is no longer needed. Update the plan (`create_goal_plan`) if scope changed._",
      "",
    );
  }

  // --- Goal status snapshot ---
  sections.push(
    "### Goal Status",
    `- Status: ${goalStatus.status}`,
    `- Budget: ${goalStatus.spentCents}/${goalStatus.budgetCents ?? "unlimited"} cents`,
    `- Sprints settled: ${sprintNumber}`,
  );
  if (goalStatus.subGoals.length > 0) {
    sections.push(
      `- Sub-goals: ${goalStatus.subGoals.map((g) => `${g.title} (${g.status})`).join(", ")}`,
    );
  }
  sections.push("");

  // --- Next-action instructions ---
  const progressWord = hasCompleted ? "based on the completed work" : "given that no tasks completed this sprint";
  sections.push(
    "### Next Action",
    "",
    `Review results ${progressWord}, update the plan if necessary, then:`,
    "",
    `1. If the goal is achieved, every success criterion is met, and you have a concrete evidence bundle, call \`mark_goal_achieved\`; do not mark achieved without evidence.`,
    `2. Otherwise, plan Sprint ${sprintNumber + 1} — create tasks via \`create_task\` with concrete \`acceptance_criteria\`.`,
    `3. Address every failed or cancelled task from this sprint explicitly before moving on.`,
  );

  return sections.join("\n");
}

export async function buildCommentWakeUpPrompt(
  sql: Sql,
  goalId: string,
  commentId: string,
): Promise<string> {
  const [comment] = await sql<
    { id: string; body: string; created_by: string; created_at: Date }[]
  >`
    SELECT id, body, created_by, created_at
    FROM goal_comments
    WHERE id = ${commentId}
  `;
  if (!comment) {
    // Caller verified the comment existed, but race-on-delete is possible.
    // Fall back to a plain "re-check state" prompt so the wake still has
    // *something* useful for the supervisor to do.
    return [
      "## Owner touched this goal",
      "",
      "An owner action notified the supervisor but the originating comment is no longer available. Re-check goal state (tasks, work products, plan) and decide whether the goal should move forward, be re-planned, or be marked complete. Reply via `POST /api/goals/" + goalId + "/comments` with the bearer header described in TOOLS.md, describing your assessment.",
    ].join("\n");
  }

  const goalStatus = await getGoalStatus(sql, goalId);
  const plan = await getGoalPlan(sql, goalId);

  const tasks = await sql<
    { id: string; title: string; status: string; assigned_to: string; result_summary: string | null; failure_reason: string | null }[]
  >`
    SELECT id, title, status, assigned_to, result_summary, failure_reason
    FROM tasks
    WHERE goal_id = ${goalId}
    ORDER BY created_at
  `;

  const sections: string[] = [
    "## Owner Comment Received",
    "",
    `The owner left a comment on this goal at ${comment.created_at.toISOString()}:`,
    "",
    "> " + comment.body.split("\n").join("\n> "),
    "",
  ];

  if (plan) {
    const planSnippet = plan.body.length > 1200 ? plan.body.slice(0, 1200) + "…" : plan.body;
    sections.push(
      `### Current Plan (${plan.title}, revision ${plan.revision})`,
      "",
      planSnippet,
      "",
    );
  }

  sections.push(
    `### Goal Status`,
    `- Status: ${goalStatus.status}`,
    `- Budget: ${goalStatus.spentCents}/${goalStatus.budgetCents ?? "unlimited"} cents`,
    "",
    `### Tasks on this goal (${tasks.length})`,
  );

  if (tasks.length === 0) {
    sections.push("_none_");
  } else {
    for (const t of tasks) {
      const detail =
        t.status === "failed" || t.status === "unresolvable"
          ? ` — ${t.failure_reason ?? "unknown reason"}`
          : t.result_summary
          ? ` — ${t.result_summary.slice(0, 160)}`
          : "";
      sections.push(`- [${t.status}] **${t.title}** (${t.assigned_to}, id: ${t.id})${detail}`);
    }
  }

  sections.push(
    "",
    "### Your task",
    "",
    "Interpret the owner's comment against the current goal state and take appropriate action:",
    "",
    `- If the owner is saying the goal is already done / resolved (e.g. "should be resolved", "fixed", "done"), **verify evidence** (query tasks via \`curl http://localhost:3002/api/goals/${goalId} -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN"\`; check git log in the hivewright repo for matching commits; inspect work_products). If evidence is present, \`curl -X POST http://localhost:3002/api/goals/${goalId}/complete -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" -H "Content-Type: application/json" -d '{"summary":"<one-paragraph achievement summary citing the verified evidence>","evidenceTaskIds":["<completed-task-id>"],"evidenceWorkProductIds":["<work-product-id>"],"evidence":[{"type":"artifact","description":"<what proves completion>","reference":"<path/url/id>","verified":true}],"learningGate":{"category":"nothing","rationale":"No reusable learning should be saved from this goal."}}'\`. Use \`learningGate.category\` = "nothing" when there is no reusable learning, or an applicable reusable category with rationale when the completion produced reusable memory, skill, template, policy candidate, pipeline candidate, or update to an existing asset.`,
    `- If the owner is asking you to cancel / drop the goal, create a decision via \`curl -X POST http://localhost:3002/api/decisions -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION"\` with kind=\"decision\" recommending cancellation (don't cancel unilaterally).`,
    `- If the owner is giving a new directive (retry X, try differently, add Y), revise the plan via \`curl -X PUT /api/goals/${goalId}/documents/plan -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION"\` and create replacement tasks. For any replacement tied to a failed or cancelled task, include \`"sourceTaskId":"<task-id>"\` for the same failed or cancelled task so recovery budgets and lineage are enforced.`,
    `- If the comment is ambiguous, **reply first** via \`curl -X POST http://localhost:3002/api/goals/${goalId}/comments -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION"\` with body={body, createdBy:\"goal-supervisor\"} stating your interpretation and asking for clarification. Do NOT guess and act.`,
    "",
    "Always leave a reply comment (createdBy=\"goal-supervisor\") summarising what you did or are about to do, so the owner sees a response in the comments panel.",
  );

  return sections.join("\n");
}

export async function terminateSupervisorSession(
  sql: Sql,
  goalId: string,
): Promise<void> {
  const [goal] = await sql`SELECT session_id FROM goals WHERE id = ${goalId}`;

  // Clean up OpenClaw agent if it exists
  if (goal?.session_id) {
    try {
      const { terminateGoalSupervisor } = await import("./supervisor-openclaw");
      await terminateGoalSupervisor(sql, goalId);
    } catch {
      // Fallback: just clear the DB
      await sql`UPDATE goals SET session_id = NULL, updated_at = NOW() WHERE id = ${goalId}`;
    }
  }
}
