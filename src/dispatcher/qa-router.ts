import type { Sql } from "postgres";
import { createOrUpdateSkillCandidateFromSignal } from "@/skills/self-creation";
import { inheritTaskWorkspaceFromParent } from "./worktree-manager";
import { markCapsuleCompleted, markCapsuleQaFailed } from "./execution-capsules";
import { findExistingQaReplanTask } from "./recovery-loop-guard";
import { parkTaskIfRecoveryBudgetExceeded } from "@/recovery/recovery-budget";

const QA_DELIVERABLE_INLINE_LIMIT = 4000;

export async function notifyGoalSupervisorOfQaFailure(
  sql: Sql,
  taskId: string,
  feedback: string | null,
): Promise<void> {
  const [task] = await sql`
    SELECT id, goal_id, sprint_number, title, brief, acceptance_criteria, project_id
    FROM tasks WHERE id = ${taskId}
  `;

  if (!task?.goal_id) return;

  const existingReplanTask = await findExistingQaReplanTask(sql, taskId);
  if (existingReplanTask) return;

  const budgetDecision = await parkTaskIfRecoveryBudgetExceeded(sql, taskId, {
    action: "QA cap goal-supervisor replan",
    reason: "QA retry cap reached for a goal task and would create a goal-supervisor replan task.",
    replacementTasksToCreate: 1,
  });
  if (!budgetDecision.ok) return;

  const replanBrief = [
    "## QA Failure Re-Planning",
    "",
    `The following sprint task failed QA repeatedly and needs automatic re-planning or decomposition.`,
    `Parent Task ID: ${task.id}`,
    `Title: ${task.title}`,
    task.sprint_number ? `Sprint: ${task.sprint_number}` : "",
    "",
    "### Original Brief",
    task.brief,
    "",
    task.acceptance_criteria ? `### Acceptance Criteria\n${task.acceptance_criteria}` : "",
    "",
    "### QA Feedback",
    feedback || "No QA feedback captured.",
    "",
    "### Your Job",
    "Decide whether to rewrite this task more precisely, split it into smaller tasks, or create replacement tasks that better satisfy the acceptance criteria.",
    "Do not ask the owner. Create the next best tasks automatically.",
  ].filter(Boolean).join("\n");

  const [replanTask] = await sql`
    INSERT INTO tasks (
      hive_id,
      assigned_to,
      created_by,
      title,
      brief,
      goal_id,
      sprint_number,
      parent_task_id,
      priority,
      qa_required,
      project_id
    )
    SELECT
      hive_id,
      'goal-supervisor',
      'dispatcher',
      ${`[Replan] QA failed repeatedly: ${task.title}`},
      ${replanBrief},
      goal_id,
      sprint_number,
      ${taskId},
      1,
      false,
      ${task.project_id}
    FROM tasks
    WHERE id = ${taskId}
    RETURNING id
  `;
  await inheritTaskWorkspaceFromParent(sql, taskId, replanTask.id as string);
}

function extractPriorQaFeedback(brief: string): string | null {
  const match = brief.match(/## QA Feedback \(Rework Required[\s\S]*$/);
  return match?.[0]?.trim() || null;
}

export async function createDirectTaskQaCapDecision(
  sql: Sql,
  taskId: string,
  feedback: string | null,
  retryCap: number,
): Promise<void> {
  const [task] = await sql`
    SELECT id, hive_id, title, brief, acceptance_criteria, assigned_to, result_summary
    FROM tasks WHERE id = ${taskId}
  `;
  if (!task) return;

  const budgetDecision = await parkTaskIfRecoveryBudgetExceeded(sql, taskId, {
    action: "QA cap direct-task recovery decision",
    reason: "QA retry cap reached for a direct task and would create an owner/EA recovery decision.",
    recoveryDecisionsToCreate: 1,
  });
  if (!budgetDecision.ok) return;

  const [workProduct] = await sql`
    SELECT content, summary, created_at
    FROM work_products
    WHERE task_id = ${taskId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const priorFeedback = extractPriorQaFeedback(task.brief as string);
  const latestFeedback = feedback || "No QA feedback captured.";
  const latestWorkProduct =
    (workProduct?.summary as string | null) ||
    (workProduct?.content as string | null) ||
    (task.result_summary as string | null) ||
    "No work product captured.";

  const context = [
    `Direct task "${task.title}" failed QA after ${retryCap} rework cycles and needs owner direction before it can continue.`,
    "",
    `Task ID: ${task.id}`,
    `Current role: ${task.assigned_to}`,
    "",
    "### Original Brief and Rework History",
    task.brief,
    "",
    task.acceptance_criteria ? `### Acceptance Criteria\n${task.acceptance_criteria}` : "",
    "",
    "### QA Feedback History",
    priorFeedback || "No earlier QA feedback was preserved in the task brief.",
    "",
    "### Latest QA Feedback",
    latestFeedback,
    "",
    "### Most Recent Work Product",
    latestWorkProduct.slice(0, 4000),
  ].filter(Boolean).join("\n");

  await sql.begin(async (tx) => {
    await tx`
      UPDATE tasks
      SET status = 'blocked',
          failure_reason = ${`QA retry cap reached (${retryCap} rework cycles). Awaiting owner recovery decision.`},
          updated_at = NOW()
      WHERE id = ${taskId}
    `;

    await tx`
      INSERT INTO decisions (
        hive_id, task_id, title, context, recommendation, options, priority, status, kind
      )
      VALUES (
        ${task.hive_id},
        ${task.id},
        ${`Task "${task.title}" failed QA twice, what next?`},
        ${context},
        ${"Recommended: refine the brief if the QA feedback shows ambiguous acceptance criteria; otherwise retry with a different role."},
        ${sql.json({
          kind: "direct_task_qa_cap_recovery",
          suggestedOption: "refine_brief_and_retry",
          taskId: task.id,
          qaFeedbackExcerpt: latestFeedback.slice(0, 500),
          options: [
            { label: "Retry with a different role", action: "retry_with_different_role" },
            { label: "Refine the brief and retry", action: "refine_brief_and_retry" },
            { label: "Abandon this task", action: "abandon" },
          ],
        })},
        'urgent',
        'ea_review',
        'decision'
      )
    `;
  });
}

async function createSkillCandidateFromQaCap(
  sql: Sql,
  taskId: string,
  feedback: string | null,
  retryCap: number,
): Promise<void> {
  const [task] = await sql<{
    id: string;
    hive_id: string;
    assigned_to: string;
    title: string;
  }[]>`
    SELECT id, hive_id, assigned_to, title
    FROM tasks
    WHERE id = ${taskId}
  `;
  if (!task?.assigned_to) return;

  try {
    await createOrUpdateSkillCandidateFromSignal(sql, {
      hiveId: task.hive_id,
      roleSlug: task.assigned_to,
      taskId,
      signalType: "qa_failure",
      summary: [
        `Task "${task.title}" reached the QA retry cap (${retryCap} rework cycles).`,
        feedback?.trim() ? `Latest QA feedback: ${feedback.trim()}` : "No QA feedback captured.",
      ].join("\n"),
      source: "qa-router",
    });
  } catch (error) {
    console.warn(
      `[skills] Failed to create/update skill candidate from QA cap failure for task ${taskId}:`,
      error,
    );
  }
}

export async function routeToQa(
  sql: Sql,
  taskId: string,
  deliverable: string,
): Promise<Record<string, unknown> | null> {
  const [task] = await sql`
    SELECT id, hive_id, title, brief, acceptance_criteria, assigned_to, project_id
    FROM tasks WHERE id = ${taskId}
  `;
  if (!task) return null;

  const [workspace] = await sql`
    SELECT base_workspace_path, worktree_path, branch_name, isolation_status,
           isolation_active, reused, failure_reason, skipped_reason
    FROM task_workspaces
    WHERE task_id = ${taskId}
  `;
  const gitEvidence = workspace
    ? [
        "### Git Evidence",
        `Isolation status: ${workspace.isolation_status}`,
        `Isolation active: ${workspace.isolation_active ? "yes" : "no"}`,
        workspace.base_workspace_path ? `Base workspace: ${workspace.base_workspace_path}` : "",
        workspace.worktree_path ? `Worktree: ${workspace.worktree_path}` : "",
        workspace.branch_name ? `Branch: ${workspace.branch_name}` : "",
        workspace.reused ? "Worktree was reused: yes" : "Worktree was reused: no",
        workspace.failure_reason ? `Failure reason: ${workspace.failure_reason}` : "",
        workspace.skipped_reason ? `Skipped reason: ${workspace.skipped_reason}` : "",
      ].filter(Boolean).join("\n")
    : "### Git Evidence\nNo task workspace metadata was recorded.";

  await sql`
    UPDATE tasks SET status = 'in_review', updated_at = NOW() WHERE id = ${taskId}
  `;

  const [workProduct] = await sql<{ id: string; created_at: Date }[]>`
    SELECT id, created_at
    FROM work_products
    WHERE task_id = ${taskId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const deliverableForQa = renderQaDeliverableReference(deliverable, workProduct);

  const qaBrief = [
    "## QA Review",
    "",
    `**Original Task:** ${task.title}`,
    `**Executed By:** ${task.assigned_to}`,
    "",
    "### Original Brief",
    task.brief,
    "",
    task.acceptance_criteria ? `### Acceptance Criteria\n${task.acceptance_criteria}` : "",
    "",
    deliverableForQa,
    "",
    gitEvidence,
    "",
    "### Your Job",
    "Review the deliverable against the acceptance criteria.",
    "First non-empty line must be exactly `pass` or `fail`.",
    "Then provide only concise evidence/issue notes needed for the parent task.",
  ].join("\n");

  const [qaTask] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, parent_task_id, priority, project_id)
    VALUES (
      ${task.hive_id},
      'qa',
      'dispatcher',
      ${`[QA] Review: ${task.title}`},
      ${qaBrief},
      ${taskId},
      2,
      ${task.project_id}
    )
    RETURNING *
  `;
  await inheritTaskWorkspaceFromParent(sql, taskId, qaTask.id as string);

  return qaTask;
}

function renderQaDeliverableReference(
  deliverable: string,
  workProduct: { id: string; created_at: Date } | undefined,
): string {
  if (deliverable.length <= QA_DELIVERABLE_INLINE_LIMIT || !workProduct) {
    return ["### Work Product / Completed Deliverable", deliverable].join("\n");
  }

  const excerpt = deliverable.slice(0, QA_DELIVERABLE_INLINE_LIMIT).trimEnd();
  return [
    "### Work Product / Completed Deliverable",
    excerpt,
    `[lean-context] ${deliverable.length - excerpt.length} character(s) omitted from the QA prompt; inspect the referenced work_product before making a final QA judgement.`,
    "",
    "### Evidence References",
    `- work_products.id: ${workProduct.id}`,
    `- work_products.created_at: ${workProduct.created_at.toISOString()}`,
    "- Full deliverable evidence remains stored in work_products.summary/content for this task.",
  ].join("\n");
}

export type QaFailureClass = "quality_fail" | "runtime_blocked" | "parser_unknown";

export interface QaResult {
  passed: boolean;
  feedback: string | null;
  /** Trusted dispatcher classification. Never infer this from untrusted QA text. */
  failureClass?: QaFailureClass;
}

export type QaVerdict = "pass" | "fail" | "unknown";

// Extract the QA agent's verdict from its full output.
// Looks for a verdict on its own line (with optional markdown decoration)
// or a "Verdict: pass/fail" style prefix line, and returns the LAST match
// so later verdicts override any preamble discussion of pass/fail criteria.
export function parseQaVerdict(output: string): QaVerdict {
  if (!output) return "unknown";

  const lines = output.replace(/\r/g, "").split("\n");
  const stripLine = (line: string) =>
    line
      .trim()
      .replace(/^[#>\-*`_\s]+/, "")
      .replace(/[*`_\s.!]+$/, "")
      .toLowerCase();

  const verdictToken = /^(pass(?:ed)?|fail(?:ed)?)$/;
  const prefixed = /^(?:qa\s+)?(?:verdict|result|outcome|overall|status|conclusion|final)\s*[:=\-–—]?\s*(pass(?:ed)?|fail(?:ed)?)\b/;

  let last: QaVerdict = "unknown";
  for (const raw of lines) {
    const line = stripLine(raw);
    if (!line) continue;

    const m = line.match(prefixed);
    if (m) {
      last = m[1].startsWith("pass") ? "pass" : "fail";
      continue;
    }

    if (verdictToken.test(line)) {
      last = line.startsWith("pass") ? "pass" : "fail";
    }
  }

  return last;
}

export async function processQaResult(
  sql: Sql,
  taskId: string,
  result: QaResult,
): Promise<void> {
  if (result.passed) {
    await sql`
      UPDATE tasks
      SET status = 'completed',
          completed_at = NOW(),
          updated_at = NOW(),
          failure_reason = NULL
      WHERE id = ${taskId}
    `;
    await markCapsuleCompleted(sql, taskId);
  } else {
    const [task] = await sql`SELECT brief, retry_count, goal_id FROM tasks WHERE id = ${taskId}`;
    const retryCount = (task?.retry_count as number) || 0;
    const QA_RETRY_CAP = 2;
    const failureClass = result.failureClass ?? "quality_fail";

    if (failureClass !== "quality_fail") {
      const reason = `${failureClass}: ${result.feedback ?? "QA/review could not produce a trusted quality verdict."}`;
      await sql`
        UPDATE tasks
        SET status = 'blocked',
            failure_reason = ${reason},
            result_summary = ${reason},
            updated_at = NOW()
        WHERE id = ${taskId}
      `;
      await markCapsuleQaFailed(sql, { taskId, feedback: reason });
      return;
    }

    if (retryCount >= QA_RETRY_CAP) {
      await markCapsuleQaFailed(sql, { taskId, feedback: result.feedback });
      await createSkillCandidateFromQaCap(sql, taskId, result.feedback, QA_RETRY_CAP);
      if (task?.goal_id) {
        await sql`
          UPDATE tasks
          SET status = 'failed', failure_reason = ${'QA retry cap reached (' + QA_RETRY_CAP + ' rework cycles). Supervisor re-planning required.'}, updated_at = NOW()
          WHERE id = ${taskId}
        `;
        await notifyGoalSupervisorOfQaFailure(sql, taskId, result.feedback);
      } else {
        await createDirectTaskQaCapDecision(sql, taskId, result.feedback, QA_RETRY_CAP);
      }
    } else {
      const qaDelta = result.feedback ?? "No QA feedback captured.";
      const updatedBrief = `${task.brief}\n\n## QA Feedback (Rework Required - attempt ${retryCount + 1}/${QA_RETRY_CAP})\n[lean-context] Address only this QA delta, then update or replace the latest work-product evidence. Do not replay the full prior transcript.\n${qaDelta}`;
      await sql`
        UPDATE tasks
        SET status = 'pending', brief = ${updatedBrief}, retry_count = ${retryCount + 1}, retry_after = NULL, updated_at = NOW()
        WHERE id = ${taskId}
      `;
      await markCapsuleQaFailed(sql, { taskId, feedback: result.feedback });
    }
  }
}
