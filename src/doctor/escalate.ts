import type { Sql } from "postgres";
import { markUnresolvable } from "../dispatcher/mark-unresolvable";
import { classifyFailureReason } from "../decisions/classify-failure-reason";

/**
 * When the doctor's output can't be parsed or validated, escalate the
 * FAILED ORIGINAL task to the owner as a Tier 3 decision and mark it
 * unresolvable. Symmetrical to applyDoctorDiagnosis's "escalate" action
 * but invoked by the dispatcher, not the doctor itself.
 */
export async function escalateMalformedDiagnosis(
  sql: Sql,
  parentTaskId: string,
  reason: string,
  doctorOutput: string,
): Promise<void> {
  const [parent] = await sql`
    SELECT hive_id, goal_id, title
    FROM tasks WHERE id = ${parentTaskId}
  `;
  if (!parent) {
    // Parent task disappeared (race with cancel/delete). Nothing to escalate.
    console.warn(
      `[doctor] escalateMalformedDiagnosis: parent task ${parentTaskId} not found`,
    );
    return;
  }

  const decisionContext = [
    `The doctor agent failed to produce a usable diagnosis for task:`,
    `  "${parent.title}"`,
    ``,
    `Parse failure reason: ${reason}`,
    ``,
    `Doctor's raw output:`,
    "```",
    doctorOutput.slice(0, 4000),
    "```",
    ``,
    `Manual intervention required: either fix the task manually, create`,
    `a new task with a corrected brief, or mark the goal as cancelled.`,
  ].join("\n");

  // Malformed doctor output is always a code/prompt problem, never a judgement
  // call. Route it to the System Health queue, not the owner's Decisions queue.
  const kind = "system_error";

  await sql.begin(async (tx) => {
    await markUnresolvable(
      tx as unknown as Sql,
      parentTaskId,
      `Doctor diagnosis parse failure: ${reason}`,
    );
    // Route through EA-first: even system_error decisions shouldn't
    // reach the owner directly. The EA can read the failure context,
    // attempt autonomous recovery (cancel orphan task, retry with a
    // different role, etc.), and only escalate with rewritten plain-
    // English context if it genuinely needs the owner's input.
    //
    // task_id pins the decision to the originating task so the EA,
    // dispatcher, adapters, and dashboard can resolve the project
    // workspace through the task row (decisions has no project_id).
    await tx`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, priority, status, kind)
      VALUES (
        ${parent.hive_id},
        ${parent.goal_id},
        ${parentTaskId},
        ${`Doctor produced malformed diagnosis for: ${parent.title}`},
        ${decisionContext},
        'urgent',
        'ea_review',
        ${kind}
      )
    `;
  });
}

/**
 * Recursion guard escalation: when a failed doctor task would otherwise spawn
 * another doctor task (which would loop until varchar(500) overflowed), the
 * dispatcher's failure-handler routes here instead. Marks the doctor task
 * unresolvable, opens a Tier 3 urgent decision against the parent task with
 * retry/reassign/drop options, and sends a push notification.
 *
 * Mirrors escalateMalformedDiagnosis (which handles the doctor-output-parse
 * failure path); both escalation routes live in this file.
 */
export async function escalateRecursionGuard(
  sql: Sql,
  failedDoctorTaskId: string,
  reason: string,
  doctorHiveId?: string,
): Promise<void> {
  await markUnresolvable(sql, failedDoctorTaskId, reason);

  const [parent] = await sql`
    SELECT t.id AS parent_id, t.hive_id, t.goal_id, t.title, t.assigned_to AS parent_role
    FROM tasks t JOIN tasks d ON d.parent_task_id = t.id
    WHERE d.id = ${failedDoctorTaskId}
  `;

  let hiveId: string;
  let goalId: string | null;
  let parentTaskId: string | null;
  let parentTitle: string;
  let parentRole: string;

  if (parent) {
    hiveId = parent.hive_id as string;
    goalId = parent.goal_id as string | null;
    parentTaskId = parent.parent_id as string;
    parentTitle = parent.title as string;
    parentRole = parent.parent_role as string;
  } else {
    // Doctor task with no parent (synthetic test data or legacy rows). Prefer
    // the hiveId the caller already has; only re-query as a last resort.
    if (doctorHiveId) {
      hiveId = doctorHiveId;
    } else {
      const [self] = await sql`SELECT hive_id FROM tasks WHERE id = ${failedDoctorTaskId}`;
      hiveId = self.hive_id as string;
    }
    goalId = null;
    parentTaskId = null;
    parentTitle = "(unknown task)";
    parentRole = "(unknown)";
  }

  // Classify: if the underlying failure looks like infrastructure (config
  // parse, ENOENT, missing env, connection refused, ...), route to the
  // System Health queue instead of paging the owner. Otherwise treat as
  // a genuine judgement call.
  const kind = classifyFailureReason(reason);

  // Route through EA-first — the EA can frequently retry, reassign, or
  // drop without the owner ever needing to see this. If it does need
  // owner input, the EA fires the notification with rewritten,
  // owner-friendly context (no "recursion guard" jargon).
  await sql`
    INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation, options, priority, status, kind)
    VALUES (
      ${hiveId},
      ${goalId},
      ${parentTaskId},
      ${`Doctor could not resolve: ${parentTitle}`},
      ${`Role '${parentRole}' hit the recursion guard after doctor attempts failed. Last error: ${reason}`},
      ${"Pick one of the options below, or resolve with a custom response."},
      ${sql.json([
        { label: "Retry the original task", action: "retry" },
        { label: "Reassign to a different role", action: "reassign" },
        { label: "Mark resolved & drop", action: "drop" },
      ])},
      'urgent',
      'ea_review',
      ${kind}
    )
  `;
}
