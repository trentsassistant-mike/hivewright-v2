import type { Sql } from "postgres";

export interface InterruptedActiveTask {
  id: string;
  title: string;
  assignedTo: string;
  dispatcherPid: number;
}

export interface StuckTask {
  id: string;
  title: string;
  assignedTo: string;
  lastHeartbeat: Date | null;
  startedAt: Date | null;
  /** Why the watchdog flagged this task — used for the failure reason. */
  reason: "no_heartbeat" | "max_runtime_exceeded";
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: string }).code
      : undefined;
    return code === "EPERM";
  }
}

/**
 * Requeue active tasks claimed by a previous dispatcher process that is no
 * longer alive. This is intentionally a startup recovery path, not a watchdog
 * timeout path: a service restart or bundle-drain interruption is lifecycle
 * noise, not an agent failure, so it should not increment retry_count or spawn
 * doctor work.
 */
export async function recoverInterruptedActiveTasks(
  sql: Sql,
  currentPid: number,
  pidAlive: (pid: number) => boolean = isPidAlive,
): Promise<InterruptedActiveTask[]> {
  const rows = await sql`
    SELECT
      id,
      title,
      assigned_to AS "assignedTo",
      dispatcher_pid AS "dispatcherPid"
    FROM tasks
    WHERE status = 'active'
      AND dispatcher_pid IS NOT NULL
      AND dispatcher_pid <> ${currentPid}
    ORDER BY started_at ASC NULLS FIRST, created_at ASC
  `;

  const interrupted = (rows as unknown as Record<string, unknown>[])
    .map((row) => ({
      id: row["id"] as string,
      title: row["title"] as string,
      assignedTo: (row["assignedTo"] ?? row["assigned_to"]) as string,
      dispatcherPid: Number(row["dispatcherPid"] ?? row["dispatcher_pid"]),
    }))
    .filter((task) => !pidAlive(task.dispatcherPid));

  for (const task of interrupted) {
    await sql`
      UPDATE tasks
      SET status = 'pending',
          failure_reason = ${`Interrupted by dispatcher lifecycle recovery: previous dispatcher PID ${task.dispatcherPid} is no longer running.`},
          dispatcher_pid = NULL,
          started_at = NULL,
          last_heartbeat = NULL,
          retry_after = NULL,
          updated_at = NOW()
      WHERE id = ${task.id}
        AND status = 'active'
        AND dispatcher_pid = ${task.dispatcherPid}
    `;
  }

  return interrupted;
}

/**
 * @param sql              Postgres connection.
 * @param timeoutMs        Heartbeat staleness threshold (default 5 min).
 * @param maxRuntimeMs     Wall-clock cap regardless of heartbeats. Catches
 *                         agents that emit periodic stderr but never finish.
 *                         Pass 0 to disable.
 */
export async function findStuckTasks(
  sql: Sql,
  timeoutMs: number,
  maxRuntimeMs: number = 0,
): Promise<StuckTask[]> {
  const timeoutSeconds = Math.floor(timeoutMs / 1000);
  const maxRuntimeSeconds = Math.floor(maxRuntimeMs / 1000);

  const rows = await sql`
    SELECT
      t.id,
      t.title,
      t.assigned_to as "assignedTo",
      t.last_heartbeat as "lastHeartbeat",
      t.started_at as "startedAt",
      CASE
        WHEN runtime_limit.effective_runtime_seconds > 0
         AND t.started_at IS NOT NULL
         AND t.started_at < NOW() - make_interval(secs => runtime_limit.effective_runtime_seconds)
        THEN 'max_runtime_exceeded'
        ELSE 'no_heartbeat'
      END AS reason
    FROM tasks t
    LEFT JOIN pipeline_step_runs psr ON psr.task_id = t.id
    LEFT JOIN pipeline_steps ps ON ps.id = psr.step_id
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN ps.max_runtime_seconds IS NOT NULL THEN ps.max_runtime_seconds
        ELSE ${maxRuntimeSeconds}
      END AS effective_runtime_seconds
    ) runtime_limit
    WHERE t.status = 'active'
      AND (
        (t.last_heartbeat IS NOT NULL AND t.last_heartbeat < NOW() - make_interval(secs => ${timeoutSeconds}))
        OR
        (t.last_heartbeat IS NULL AND t.started_at < NOW() - make_interval(secs => ${timeoutSeconds}))
        OR
        (
          runtime_limit.effective_runtime_seconds > 0
          AND t.started_at IS NOT NULL
          AND t.started_at < NOW() - make_interval(secs => runtime_limit.effective_runtime_seconds)
        )
      )
  `;

  // postgres.js may return snake_case keys despite AS aliases — normalize to camelCase
  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row["id"] as string,
    title: row["title"] as string,
    assignedTo: (row["assignedTo"] ?? row["assigned_to"]) as string,
    lastHeartbeat: (row["lastHeartbeat"] ?? row["last_heartbeat"] ?? null) as Date | null,
    startedAt: (row["startedAt"] ?? row["started_at"] ?? null) as Date | null,
    reason: (row["reason"] as StuckTask["reason"]) ?? "no_heartbeat",
  }));
}

export interface DeadEndReviewTask {
  id: string;
  goalId: string;
  failedQaChildId: string;
  failedQaReason: string | null;
}

/**
 * Find dev-agent (or other) tasks stuck in `in_review` whose latest [QA] Review
 * child is in a terminal-failure state (`blocked`, `failed`, `unresolvable`).
 *
 * The state machine has no native edge out of this dead end — `in_review` waits
 * for a QA verdict that never comes, the supervisor wake skips goals with any
 * `in_review` task, so the goal silently freezes.
 *
 * Caller marks the parent failed and triggers `notifyGoalSupervisorOfQaFailure`
 * (the existing replan path), which gets the goal moving again.
 */
export async function findDeadEndReviewTasks(sql: Sql): Promise<DeadEndReviewTask[]> {
  const rows = await sql`
    SELECT DISTINCT ON (parent.id)
      parent.id AS "id",
      parent.goal_id AS "goalId",
      qa.id AS "failedQaChildId",
      qa.failure_reason AS "failedQaReason"
    FROM tasks parent
    JOIN tasks qa ON qa.parent_task_id = parent.id
    WHERE parent.status = 'in_review'
      AND parent.goal_id IS NOT NULL
      AND qa.title LIKE '[QA] Review:%'
      AND qa.status IN ('blocked', 'failed', 'unresolvable')
    ORDER BY parent.id, qa.created_at DESC
  `;

  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row["id"] as string,
    goalId: (row["goalId"] ?? row["goal_id"]) as string,
    failedQaChildId: (row["failedQaChildId"] ?? row["failed_qa_child_id"]) as string,
    failedQaReason: (row["failedQaReason"] ?? row["failed_qa_reason"] ?? null) as string | null,
  }));
}

export interface StuckBlockedTask {
  id: string;
  title: string;
  goalId: string | null;
  blockedSinceMs: number;
  failureReason: string | null;
  reason: "blocked_too_long" | "fast_terminal_failure";
}

function terminalAdapterFailureSqlPattern(): string {
  return [
    "OPENAI_API_KEY",
    "Pre-flight failed",
    "Missing required",
    "credential",
    "provision",
    "adapter",
    "Spawn failed",
    "Spawn error",
    "exited code",
    "runtime",
    "Codex image runtime",
    "no predictable PNG/JPEG artifact path",
  ].join("|");
}

/**
 * Find tasks that have been sitting in `blocked` for too long with no
 * resolving doctor or owner-decision child task in flight. Doctor `fix_environment`
 * sets a parent to `blocked` and creates a sibling repair task — but if that
 * repair task itself fails (or never gets created because the env problem keeps
 * recurring), the parent freezes forever. This catches that case.
 */
export async function findStuckBlockedTasks(
  sql: Sql,
  ageMs: number,
  fastFailureAgeMs = 5 * 60 * 1000,
): Promise<StuckBlockedTask[]> {
  const ageSeconds = Math.floor(ageMs / 1000);
  if (ageSeconds <= 0) return [];
  const fastFailureSeconds = Math.max(0, Math.floor(fastFailureAgeMs / 1000));
  const fastFailurePattern = terminalAdapterFailureSqlPattern();

  const rows = await sql`
    SELECT
      t.id AS "id",
      t.title AS "title",
      t.goal_id AS "goalId",
      EXTRACT(EPOCH FROM (NOW() - t.updated_at)) * 1000 AS "blockedSinceMs",
      t.failure_reason AS "failureReason",
      CASE
        WHEN ${fastFailureSeconds} > 0
          AND t.updated_at < NOW() - make_interval(secs => ${fastFailureSeconds})
          AND COALESCE(t.failure_reason, '') ~* ${fastFailurePattern}
        THEN 'fast_terminal_failure'
        ELSE 'blocked_too_long'
      END AS "reason"
    FROM tasks t
    WHERE t.status = 'blocked'
      AND (
        t.updated_at < NOW() - make_interval(secs => ${ageSeconds})
        OR (
          ${fastFailureSeconds} > 0
          AND t.updated_at < NOW() - make_interval(secs => ${fastFailureSeconds})
          AND COALESCE(t.failure_reason, '') ~* ${fastFailurePattern}
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks child
        WHERE child.parent_task_id = t.id
          AND child.status IN ('pending', 'active')
      )
  `;

  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row["id"] as string,
    title: row["title"] as string,
    goalId: (row["goalId"] ?? row["goal_id"] ?? null) as string | null,
    blockedSinceMs: Number(row["blockedSinceMs"] ?? row["blocked_since_ms"] ?? 0),
    failureReason: (row["failureReason"] ?? row["failure_reason"] ?? null) as string | null,
    reason: (row["reason"] as StuckBlockedTask["reason"]) ?? "blocked_too_long",
  }));
}
