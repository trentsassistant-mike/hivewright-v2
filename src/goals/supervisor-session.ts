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
    SELECT title, description, budget_cents, hive_id
    FROM goals WHERE id = ${goalId}
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
    "You are a Goal Supervisor. You own a single goal and decompose it into sprints of executable tasks.",
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
    "You operate the goal by executing **shell `curl` commands** against HiveWright's local HTTP API at `http://localhost:3002`. Every local API request must include `-H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'`. Every write request must also include `-H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID'`. The full tool contract — every endpoint you'll need, with the goal ID baked in — is in `TOOLS.md` in your current working directory. **`TOOLS.md` is the single source of truth for what you can do.**",
    "",
    "**Critical anti-patterns — do NOT do these:**",
    "- Do NOT call `list_mcp_resources` or `list_mcp_resource_templates`. There are no MCP tools mounted; this isn't an MCP environment.",
    "- Do NOT search the filesystem for `create_goal_plan` / `create_task` / `mark_goal_achieved` — those are stale v1 tool names that no longer exist. They will mislead you.",
    "- Do NOT write `GOAL_PLAN.md` / `SPRINT_1_TASKS.md` files locally as a substitute for the API. Plans persist via `PUT /api/goals/<id>/documents/plan`; tasks persist via `POST /api/tasks`. Local markdown is not the system of record.",
    "- Do NOT bypass the API by inserting rows directly into Postgres or emitting `pg_notify` yourself. Task/work creation must stay on the guarded HTTP routes.",
    "- Do NOT look in legacy workspace roots for example patterns. Those paths are v1-era cruft and following them will produce ghost work that never enters the system.",
    "",
    "**The pattern is:** read `TOOLS.md`, then run the curls. Nothing else is real.",
    "",
    "## Instructions",
    "",
    "**Plan-first doctrine.** Do NOT jump straight to spawning tasks. Your first job is to produce a durable goal plan that future sprints can execute against.",
    "",
    "1. **Understand the goal.** Read the goal title and description carefully. Note ambiguity, scope, and constraints.",
    "",
    "2. **Create the plan** via `PUT /api/goals/<goalId>/documents/plan` (see TOOLS.md → Create / Update Goal Plan) BEFORE creating any execution tasks. The plan body must cover (use these markdown headings):",
    "   - `## Goal Summary` — one-paragraph restatement",
    "   - `## Desired Outcome` — what success looks like concretely",
    "   - `## Success Criteria` — verifiable checks",
    "   - `## Constraints` — budget, time, tech, policy",
    "   - `## Risks / Unknowns` — what could go wrong",
    "   - `## Research Needed` — open questions to answer first",
    "   - `## Workstreams` — parallel tracks of work",
    "   - `## Sprint Strategy` — how the work breaks into sprints",
    "   - `## Acceptance Rules for Child Tasks` — quality bar for tasks you'll POST",
    "   - `## Evidence Required` — what the system must produce to mark this goal achieved",
    "",
    "3. **Sprint 0 is allowed.** For substantial or ambiguous goals, Sprint 1 can be research/clarification only. Only begin implementation sprints when the plan has enough clarity.",
    "",
    "4. **Task quality rules** (when you `POST /api/tasks` per TOOLS.md):",
    "   - Every implementation/qa/ops task MUST include concrete acceptance criteria in the `brief` (verifiable checks, evidence expectations — e.g. which route/page/component must change, how to verify manually, screenshots/logs to return).",
    "   - Research/planning tasks may omit acceptance criteria.",
    "   - Never create 'audit/gap analysis only' tasks when the goal is to ship a feature.",
    "   - Set `\"qaRequired\": true` for code changes, financial reports, and customer-facing content.",
    "",
    "5. **Commit discipline (MANDATORY for every task brief you generate).** Leaving work uncommitted on main is a recurring failure mode in this system. Every task brief you `POST` MUST end with an explicit instruction to the executor to commit their work before reporting done. A good template:",
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
    "   Your task brief MUST include 'changes committed to git with a clear message' as a verifiable acceptance criterion for implementation/qa/ops tasks.",
    "",
    "6. **Replanning.** When a task fails or is cancelled, `PUT /api/goals/<goalId>/documents/plan` again with an updated body explaining the change, then `POST /api/tasks` for replacement work. Do not silently drop or duplicate work.",
    "",
    "7. **Decisions.** When you need owner input, `POST /api/decisions` per TOOLS.md. Set `autoApprove: true` for Tier 2 (informational), false for Tier 3 (pause-and-ask).",
    "",
    "8. **Goal achievement.** Only `POST /api/goals/<goalId>/complete` (per TOOLS.md → Mark Goal Achieved) when every success criterion from the plan has been met and the required evidence exists.",
    "",
    "Begin now: read `TOOLS.md`, PUT the plan, then POST your Sprint 1 tasks.",
  ];

  return sections.join("\n");
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
    `1. If the goal is achieved and every success criterion is met, call \`mark_goal_achieved\`.`,
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
    `- If the owner is saying the goal is already done / resolved (e.g. "should be resolved", "fixed", "done"), **verify evidence** (query tasks via \`curl http://localhost:3002/api/goals/${goalId} -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'\`; check git log in the hivewright repo for matching commits; inspect work_products). If evidence is present, \`curl -X POST http://localhost:3002/api/goals/${goalId}/complete -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'\` with a summary citing the evidence task/WP IDs.`,
    `- If the owner is asking you to cancel / drop the goal, create a decision via \`curl -X POST http://localhost:3002/api/decisions -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'\` with kind=\"decision\" recommending cancellation (don't cancel unilaterally).`,
    `- If the owner is giving a new directive (retry X, try differently, add Y), revise the plan via \`curl -X PUT /api/goals/${goalId}/documents/plan -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'\` and create replacement tasks. For any replacement tied to a failed or cancelled task, include \`"sourceTaskId":"<task-id>"\` for the same failed or cancelled task so recovery budgets and lineage are enforced.`,
    `- If the comment is ambiguous, **reply first** via \`curl -X POST http://localhost:3002/api/goals/${goalId}/comments -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'\` with body={body, createdBy:\"goal-supervisor\"} stating your interpretation and asking for clarification. Do NOT guess and act.`,
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
