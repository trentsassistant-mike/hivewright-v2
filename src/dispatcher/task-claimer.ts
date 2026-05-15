import type { Sql } from "postgres";
import {
  advancePipelineRunFromTask,
  failPipelineRunFromTask,
  getPipelineTaskExecutionRules,
  markPipelineTaskRunning,
  validatePipelineOutputContract,
} from "@/pipelines/service";
import type { ClaimedTask } from "./types";
import { pauseOverBudgetGoalsForClaim } from "./budget-policy";

export async function claimNextTask(sql: Sql, pid: number): Promise<ClaimedTask | null> {
  await pauseOverBudgetGoalsForClaim(sql);

  // Per-role serialisation: skip a pending task if its assigned role has
  // already reached its `role_templates.concurrency_limit` of active tasks.
  //
  // Originally this cap was hardcoded to 1 because OpenClaw shared one
  // session-file per agent slug and concurrent runs collided on the
  // .jsonl.lock. OpenClaw is retired (2026-04-21), so the cap is now
  // configurable per role via `role_templates.concurrency_limit`. Sensible
  // defaults seeded in migration 0038: dev/qa/research/security at 3,
  // doctor + hive-supervisor at 1, goal-supervisor at 50 (effectively
  // unlimited; supervisors run persistent per-goal sessions where
  // serialisation would deadlock).
  //
  // The dispatcher-wide maxConcurrentTasks cap still bounds total in-flight
  // work — per-role limits compose with that.
  const rows = await sql`
    UPDATE tasks
    SET status = 'active', started_at = NOW(), dispatcher_pid = ${pid}, updated_at = NOW()
    WHERE id = (
      SELECT t.id FROM tasks t
      WHERE t.status = 'pending'
        AND (t.retry_after IS NULL OR t.retry_after <= NOW())
        AND NOT EXISTS (
          SELECT 1
          FROM hive_runtime_locks hrl
          WHERE hrl.hive_id = t.hive_id
            AND hrl.creation_paused = true
        )
        AND (
          t.goal_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM goals g
            WHERE g.id = t.goal_id
              AND g.status = 'active'
          )
        )
        AND (
          SELECT COUNT(*) FROM tasks busy
          WHERE busy.status = 'active'
            AND busy.assigned_to = t.assigned_to
        ) < COALESCE(
          (SELECT concurrency_limit FROM role_templates WHERE slug = t.assigned_to),
          1
        )
      ORDER BY t.priority ASC, t.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      id, hive_id as "hiveId", assigned_to as "assignedTo",
      created_by as "createdBy", status, priority, title, brief,
      parent_task_id as "parentTaskId", goal_id as "goalId",
      sprint_number as "sprintNumber", qa_required as "qaRequired",
      acceptance_criteria as "acceptanceCriteria",
      retry_count as "retryCount", doctor_attempts as "doctorAttempts",
      failure_reason as "failureReason",
      adapter_override as "adapterOverride",
      model_override as "modelOverride",
      project_id as "projectId"
  `;

  if (rows.length === 0) return null;

  const row = rows[0] as Record<string, unknown>;
  await markPipelineTaskRunning(sql, row["id"] as string);

  // postgres.js may return snake_case keys despite AS aliases — normalize to camelCase
  const task: ClaimedTask = {
    id: (row["id"] ?? row["id"]) as string,
    hiveId: (row["hiveId"] ?? row["hive_id"]) as string,
    assignedTo: (row["assignedTo"] ?? row["assigned_to"]) as string,
    createdBy: (row["createdBy"] ?? row["created_by"]) as string,
    status: (row["status"]) as ClaimedTask["status"],
    priority: (row["priority"]) as number,
    title: (row["title"]) as string,
    brief: (row["brief"]) as string,
    parentTaskId: (row["parentTaskId"] ?? row["parent_task_id"] ?? null) as string | null,
    goalId: (row["goalId"] ?? row["goal_id"] ?? null) as string | null,
    sprintNumber: (row["sprintNumber"] ?? row["sprint_number"] ?? null) as number | null,
    qaRequired: (row["qaRequired"] ?? row["qa_required"]) as boolean,
    acceptanceCriteria: (row["acceptanceCriteria"] ?? row["acceptance_criteria"] ?? null) as string | null,
    retryCount: (row["retryCount"] ?? row["retry_count"]) as number,
    doctorAttempts: (row["doctorAttempts"] ?? row["doctor_attempts"]) as number,
    failureReason: (row["failureReason"] ?? row["failure_reason"] ?? null) as string | null,
    adapterOverride: (row["adapterOverride"] ?? row["adapter_override"] ?? null) as string | null,
    modelOverride: (row["modelOverride"] ?? row["model_override"] ?? null) as string | null,
    projectId: (row["projectId"] ?? row["project_id"] ?? null) as string | null,
  };

  return task;
}

export async function releaseTask(sql: Sql, taskId: string, retryAfterSeconds: number, reason = "Pipeline step retry budget exceeded"): Promise<void> {
  const rules = await getPipelineTaskExecutionRules(sql, taskId);
  const [task] = await sql<{ retry_count: number }[]>`
    SELECT retry_count FROM tasks WHERE id = ${taskId}
  `;
  const retryCount = Number(task?.retry_count ?? 0);
  if (rules && retryCount >= rules.maxRetries) {
    await failPipelineRunFromTask(sql, { taskId, reason });
    return;
  }

  await sql`
    UPDATE tasks
    SET
      status = 'pending',
      retry_count = retry_count + 1,
      retry_after = NOW() + make_interval(secs => ${retryAfterSeconds}),
      dispatcher_pid = NULL,
      started_at = NULL,
      updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

export async function failTask(sql: Sql, taskId: string, reason: string): Promise<void> {
  await sql`
    UPDATE tasks
    SET status = 'failed', failure_reason = ${reason}, updated_at = NOW()
    WHERE id = ${taskId}
  `;
}

export async function completeTask(
  sql: Sql,
  taskId: string,
  resultSummary: string,
  options: { runtimeWarnings?: string[] } = {},
): Promise<void> {
  const rules = await getPipelineTaskExecutionRules(sql, taskId);
  if (rules) {
    const validation = validatePipelineOutputContract(resultSummary, rules.outputContract, {
      sourceContext: rules.sourceContext,
      driftCheck: rules.driftCheck,
    });
    if (!validation.valid) {
      const issues = [
        validation.missingFields.length > 0 ? `missing required field(s): ${validation.missingFields.join(", ")}` : null,
        ...validation.invalidFields,
        ...validation.driftIssues,
      ].filter((issue): issue is string => Boolean(issue));
      const reason = `Pipeline output contract failed: ${issues.join("; ")}.`;
      await failPipelineRunFromTask(sql, { taskId, reason });
      return;
    }
  }

  // Clear failure_reason on success so a stale message from a prior watchdog
  // hit / earlier retry doesn't keep showing up on the dashboard for a task
  // that ultimately succeeded. Runtime warnings are explicitly retained as a
  // visible QA guardrail for adapter-layer anomalies that did not prevent
  // output persistence.
  const warning = options.runtimeWarnings?.filter(Boolean).join("\n") || null;
  const updated = await sql<{ id: string }[]>`
    UPDATE tasks
    SET status = 'completed', result_summary = ${resultSummary},
        completed_at = NOW(), updated_at = NOW(), failure_reason = ${warning}
    WHERE id = ${taskId}
      AND status <> 'completed'
    RETURNING id
  `;

  if (updated.length === 0) return;

  await advancePipelineRunFromTask(sql, { taskId, resultSummary });
}

export async function blockTask(sql: Sql, taskId: string, reason?: string): Promise<void> {
  await sql`
    UPDATE tasks
    SET status = 'blocked',
        failure_reason = COALESCE(${reason ?? null}, failure_reason),
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
}
