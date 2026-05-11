import type { Sql } from "postgres";
import type { DispatcherConfig } from "./types";
import { releaseTask, failTask } from "./task-claimer";
import { markUnresolvable } from "./mark-unresolvable";
import { createDoctorTask } from "../doctor";
import { escalateRecursionGuard } from "../doctor/escalate";
import { inheritTaskWorkspaceFromParent } from "./worktree-manager";
import { parkTaskIfRecoveryBudgetExceeded } from "@/recovery/recovery-budget";

const DOCTOR_RUNTIME_FALLBACK_ADAPTER = "auto";
const DOCTOR_RUNTIME_FALLBACK_MODEL = "auto";

export enum FailureCategory {
  SpawnFailure = "spawn_failure",
  AgentTimeout = "agent_timeout",
  AgentReported = "agent_reported",
  ExecutionSliceExceeded = "execution_slice_exceeded",
}

export type FailureResult = "retried" | "doctor" | "unresolvable";

export function isRuntimeCrash(failureReason: string | null | undefined): boolean {
  const reason = failureReason?.trim();
  if (!reason) return false;

  return [
    /^Codex exited code \d+/i,
    /^Claude exited code \d+/i,
    /^Process exited with code \d+/i,
    /^Process killed\b/i,
    /^Spawn failed\b/i,
    /^Spawn error\b/i,
    /^Failed to start session\b/i,
    /^Session send failed\b/i,
  ].some((pattern) => pattern.test(reason));
}

export async function handleTaskFailure(
  sql: Sql,
  taskId: string,
  category: FailureCategory,
  reason: string,
  config: DispatcherConfig,
): Promise<FailureResult> {
  const [task] = await sql`
    SELECT
      t.retry_count,
      t.doctor_attempts,
      t.assigned_to,
      t.hive_id,
      t.parent_task_id,
      t.adapter_override,
      rt.adapter_type
    FROM tasks t
    LEFT JOIN role_templates rt ON rt.slug = t.assigned_to
    WHERE t.id = ${taskId}
  `;

  if (!task) throw new Error(`Task ${taskId} not found`);

  // Recursion guard: a failed doctor task must never spawn another doctor task.
  // doctor_attempts lives on the *parent* task, so each recursively-spawned
  // doctor would otherwise start with doctor_attempts=0 and bypass the existing
  // exhaustion check, producing an unbounded loop limited only by varchar(500)
  // overflow on the title prefix. Mark unresolvable instead.
  if (task.assigned_to === "doctor") {
    if (isRuntimeCrash(reason)) {
      const handled = await handleDoctorRuntimeCrash(sql, {
        taskId,
        reason,
        hiveId: task.hive_id as string,
        parentTaskId: task.parent_task_id as string | null,
        effectiveAdapter: ((task.adapter_override as string | null) ?? (task.adapter_type as string | null)) ?? null,
      });
      if (handled === "retry_created") return "retried";
      if (handled === "escalated") return "unresolvable";
    }

    await escalateRecursionGuard(sql, taskId, reason, task.hive_id as string);
    return "unresolvable";
  }

  // Check if doctor has exhausted attempts
  if (task.doctor_attempts >= config.maxDoctorAttempts) {
    await markUnresolvable(sql, taskId, reason);
    return "unresolvable";
  }

  // Agent-reported failures and explicit execution-slice overruns go straight to doctor (no auto-retry)
  if (category === FailureCategory.AgentReported || category === FailureCategory.ExecutionSliceExceeded) {
    const budgetDecision = await parkTaskIfRecoveryBudgetExceeded(sql, taskId, {
      action: "dispatcher doctor handoff",
      reason,
      doctorTasksToCreate: 1,
    });
    if (!budgetDecision.ok) {
      return "unresolvable";
    }

    await failTask(sql, taskId, reason);
    return "doctor";
  }

  // Spawn failures and timeouts: retry with backoff if under limit
  if (task.retry_count < config.maxRetries) {
    const backoffSeconds = [60, 300, 900][task.retry_count] ?? 900;
    await releaseTask(sql, taskId, backoffSeconds, reason);
    return "retried";
  }

  // Spawn failures and timeouts after max retries → unresolvable (not doctor)
  await markUnresolvable(sql, taskId, reason);
  return "unresolvable";
}

async function handleDoctorRuntimeCrash(
  sql: Sql,
  input: {
    taskId: string;
    reason: string;
    hiveId: string;
    parentTaskId: string | null;
    effectiveAdapter: string | null;
  },
): Promise<"retry_created" | "escalated" | null> {
  if (!input.parentTaskId) return null;

  await markUnresolvable(sql, input.taskId, input.reason);

  if (input.effectiveAdapter !== DOCTOR_RUNTIME_FALLBACK_ADAPTER) {
    const [existingFallback] = await sql`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${input.parentTaskId}
        AND assigned_to = 'doctor'
        AND adapter_override = ${DOCTOR_RUNTIME_FALLBACK_ADAPTER}
      LIMIT 1
    `;
    if (existingFallback) {
      console.warn(
        `[dispatcher] Doctor runtime fallback already exists for parent ${input.parentTaskId}: ${existingFallback.id}`,
      );
      return "retry_created";
    }

    const [failedDoctor] = await sql`
      SELECT title, brief, priority, goal_id, sprint_number, project_id
      FROM tasks
      WHERE id = ${input.taskId}
    `;
    if (!failedDoctor) return null;

    const [retry] = await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        title,
        brief,
        parent_task_id,
        priority,
        goal_id,
        sprint_number,
        project_id,
        adapter_override,
        model_override
      )
      VALUES (
        ${input.hiveId},
        'doctor',
        'dispatcher',
        ${`[Doctor retry: ${DOCTOR_RUNTIME_FALLBACK_ADAPTER}] ${failedDoctor.title}`},
        ${failedDoctor.brief},
        ${input.parentTaskId},
        ${failedDoctor.priority ?? 1},
        ${failedDoctor.goal_id},
        ${failedDoctor.sprint_number},
        ${failedDoctor.project_id},
        ${DOCTOR_RUNTIME_FALLBACK_ADAPTER},
        ${DOCTOR_RUNTIME_FALLBACK_MODEL}
      )
      RETURNING id
    `;
    await inheritTaskWorkspaceFromParent(sql, input.taskId, retry.id as string);

    console.warn(
      `[dispatcher] Doctor runtime crash on task ${input.taskId} via ${input.effectiveAdapter ?? "role-default"}; created ${DOCTOR_RUNTIME_FALLBACK_ADAPTER} retry ${retry.id} for parent ${input.parentTaskId}`,
    );
    return "retry_created";
  }

  const crashRows = await sql<{ id: string; failure_reason: string | null; adapter_override: string | null }[]>`
    SELECT id, failure_reason, adapter_override
    FROM tasks
    WHERE parent_task_id = ${input.parentTaskId}
      AND assigned_to = 'doctor'
      AND (
        failure_reason IS NOT NULL
        OR id = ${input.taskId}
      )
    ORDER BY created_at ASC
  `;
  const failureLines = crashRows
    .filter((row) => isRuntimeCrash(row.failure_reason) || row.id === input.taskId)
    .map((row) => `- ${row.id} (${row.adapter_override ?? "role-default"}): ${row.failure_reason ?? input.reason}`);

  const [parent] = await sql`
    SELECT hive_id, goal_id, title
    FROM tasks
    WHERE id = ${input.parentTaskId}
  `;
  if (!parent) return null;

  await sql`
    INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation, priority, status, kind)
    VALUES (
      ${parent.hive_id},
      ${parent.goal_id},
      ${input.parentTaskId},
      ${`Doctor runtime fallback failed for: ${parent.title}`},
      ${[
        "The doctor task failed at the runtime/process layer on both the primary runtime and the fallback runtime.",
        "",
        "Runtime failure reasons:",
        ...(failureLines.length > 0 ? failureLines : [`- ${input.taskId} (${DOCTOR_RUNTIME_FALLBACK_ADAPTER}): ${input.reason}`]),
      ].join("\n")},
      ${"Requires owner decision or manual system investigation before retrying the original task."},
      'urgent',
      'ea_review',
      'system_error'
    )
  `;

  console.error(
    `[dispatcher] Doctor runtime fallback also crashed for parent ${input.parentTaskId}; created Tier 3 system_error decision`,
  );
  return "escalated";
}

/**
 * Combined handler: handles the failure and creates a doctor task if needed.
 */
export async function handleTaskFailureAndDoctor(
  sql: Sql,
  taskId: string,
  category: FailureCategory,
  reason: string,
  config: DispatcherConfig,
): Promise<FailureResult> {
  const result = await handleTaskFailure(sql, taskId, category, reason, config);

  if (result === "doctor") {
    const doctorTask = await createDoctorTask(sql, taskId);
    if (doctorTask) {
      console.log(`[dispatcher] Created doctor task ${doctorTask.id} for failed task ${taskId}`);
    }
  }

  return result;
}
