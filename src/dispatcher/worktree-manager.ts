import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Sql } from "postgres";
import type { SessionContext, TaskWorkspaceIsolationContext } from "../adapters/types";

const execFileAsync = promisify(execFile);

export interface ProvisionTaskWorkspaceResult extends TaskWorkspaceIsolationContext {
  metadataPersisted: boolean;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

function sanitizeBranchPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "task";
}

export function taskWorktreePath(baseWorkspacePath: string, taskId: string): string {
  return path.join(baseWorkspacePath, ".claude", "worktrees", taskId);
}

export function taskBranchName(taskId: string, roleSlug: string): string {
  return `hw/task/${taskId.slice(0, 8)}-${sanitizeBranchPart(roleSlug)}`;
}

async function git(args: string[], cwd: string): Promise<GitCommandResult> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

async function isGitWorkTree(workspacePath: string): Promise<boolean> {
  try {
    const result = await git(["rev-parse", "--is-inside-work-tree"], workspacePath);
    return result.stdout === "true";
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], cwd);
    return true;
  } catch {
    return false;
  }
}

async function persistTaskWorkspace(
  sql: Sql,
  ctx: SessionContext,
  metadata: TaskWorkspaceIsolationContext,
): Promise<void> {
  const nowSql = metadata.reused ? sql`NOW()` : sql`NULL`;
  await sql`
    INSERT INTO task_workspaces (
      task_id,
      base_workspace_path,
      worktree_path,
      branch_name,
      isolation_status,
      isolation_active,
      reused,
      failure_reason,
      skipped_reason,
      reused_at,
      updated_at
    )
    VALUES (
      ${ctx.task.id},
      ${metadata.baseWorkspacePath},
      ${metadata.worktreePath},
      ${metadata.branchName},
      ${metadata.status},
      ${metadata.isolationActive},
      ${metadata.reused},
      ${metadata.status === "failed" ? metadata.reason : null},
      ${metadata.status === "skipped" ? metadata.reason : null},
      ${nowSql},
      NOW()
    )
    ON CONFLICT (task_id) DO UPDATE SET
      base_workspace_path = EXCLUDED.base_workspace_path,
      worktree_path = EXCLUDED.worktree_path,
      branch_name = EXCLUDED.branch_name,
      isolation_status = EXCLUDED.isolation_status,
      isolation_active = EXCLUDED.isolation_active,
      reused = EXCLUDED.reused,
      failure_reason = EXCLUDED.failure_reason,
      skipped_reason = EXCLUDED.skipped_reason,
      reused_at = EXCLUDED.reused_at,
      updated_at = NOW()
  `;
}

function applyIsolationContext(
  ctx: SessionContext,
  metadata: TaskWorkspaceIsolationContext,
): ProvisionTaskWorkspaceResult {
  ctx.baseProjectWorkspace = metadata.baseWorkspacePath;
  ctx.workspaceIsolation = metadata;
  if (metadata.isolationActive && metadata.worktreePath) {
    ctx.projectWorkspace = metadata.worktreePath;
  }
  return { ...metadata, metadataPersisted: true };
}

async function loadExistingTaskWorkspace(
  sql: Sql,
  ctx: SessionContext,
): Promise<ProvisionTaskWorkspaceResult | null> {
  const [row] = await sql<{
    base_workspace_path: string | null;
    worktree_path: string | null;
    branch_name: string | null;
    isolation_status: TaskWorkspaceIsolationContext["status"];
    isolation_active: boolean;
    reused: boolean;
    failure_reason: string | null;
    skipped_reason: string | null;
  }[]>`
    SELECT base_workspace_path, worktree_path, branch_name, isolation_status,
           isolation_active, reused, failure_reason, skipped_reason
    FROM task_workspaces
    WHERE task_id = ${ctx.task.id}
  `;
  if (!row) return null;

  const metadata: TaskWorkspaceIsolationContext = {
    status: row.isolation_status,
    baseWorkspacePath: row.base_workspace_path,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    isolationActive: row.isolation_active,
    reused: row.reused,
    reason: row.failure_reason ?? row.skipped_reason,
  };
  return applyIsolationContext(ctx, metadata);
}

export async function inheritTaskWorkspaceFromParent(
  sql: Sql,
  parentTaskId: string,
  childTaskId: string,
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO task_workspaces (
      task_id,
      base_workspace_path,
      worktree_path,
      branch_name,
      isolation_status,
      isolation_active,
      reused,
      failure_reason,
      skipped_reason,
      reused_at,
      updated_at
    )
    SELECT
      ${childTaskId},
      base_workspace_path,
      worktree_path,
      branch_name,
      isolation_status,
      isolation_active,
      true,
      failure_reason,
      skipped_reason,
      NOW(),
      NOW()
    FROM task_workspaces
    WHERE task_id = ${parentTaskId}
    ON CONFLICT (task_id) DO UPDATE SET
      base_workspace_path = EXCLUDED.base_workspace_path,
      worktree_path = EXCLUDED.worktree_path,
      branch_name = EXCLUDED.branch_name,
      isolation_status = EXCLUDED.isolation_status,
      isolation_active = EXCLUDED.isolation_active,
      reused = true,
      failure_reason = EXCLUDED.failure_reason,
      skipped_reason = EXCLUDED.skipped_reason,
      reused_at = NOW(),
      updated_at = NOW()
    RETURNING task_id
  `;
  return rows.length > 0;
}

async function skipped(
  sql: Sql,
  ctx: SessionContext,
  reason: string,
  baseWorkspacePath: string | null = ctx.projectWorkspace,
): Promise<ProvisionTaskWorkspaceResult> {
  const metadata: TaskWorkspaceIsolationContext = {
    status: "skipped",
    baseWorkspacePath,
    worktreePath: null,
    branchName: null,
    isolationActive: false,
    reused: false,
    reason,
  };
  await persistTaskWorkspace(sql, ctx, metadata);
  return applyIsolationContext(ctx, metadata);
}

async function failed(
  sql: Sql,
  ctx: SessionContext,
  reason: string,
  baseWorkspacePath: string | null,
  worktreePath: string | null,
  branchName: string | null,
): Promise<ProvisionTaskWorkspaceResult> {
  const metadata: TaskWorkspaceIsolationContext = {
    status: "failed",
    baseWorkspacePath,
    worktreePath,
    branchName,
    isolationActive: false,
    reused: false,
    reason,
  };
  await persistTaskWorkspace(sql, ctx, metadata);
  return applyIsolationContext(ctx, metadata);
}

/**
 * Status returned by `provisionWorktree`. Distinct from
 * `TaskWorkspaceIsolationStatus` because the focused helper distinguishes a
 * caller-disabled (null/empty base) request from a runtime-skipped (base
 * exists but is not git-backed) outcome.
 */
export type WorktreeProvisionStatus = "active" | "skipped" | "disabled";

export interface WorktreeProvisionMetadata {
  taskId: string;
  status: WorktreeProvisionStatus;
  baseWorkspace: string | null;
  worktreePath: string | null;
  branchName: string | null;
  reused: boolean;
  reason: string | null;
}

export interface WorktreeProvisionResult extends WorktreeProvisionMetadata {
  /** True when the injected `persist` was provided AND completed successfully. */
  metadataPersisted: boolean;
}

export interface ProvisionWorktreeDeps {
  /**
   * Policy gate: callers must assert the workspace came from an explicit
   * project with projects.git_repo=true. Git-looking hive paths or projects
   * with git_repo=false are not eligible for worktree provisioning.
   */
  gitBackedProject?: boolean;
  /**
   * Persist worktree metadata. Awaited before any return so callers and
   * downstream consumers (supervisor, doctor, audit) cannot observe the
   * provisioned worktree before its row exists.
   */
  persist?: (metadata: WorktreeProvisionMetadata) => Promise<void>;
  /** Logger for explicit reasons on disabled/skipped paths. Defaults to console. */
  log?: (level: "info" | "warn", message: string) => void;
}

export const HW_WORKTREE_BRANCH_PREFIX = "hw/worktree/";

/**
 * Deterministic, sanitized branch name derived from a task id and prefixed
 * for HiveWright worktree provisioning. Distinct prefix from the role-aware
 * `taskBranchName(taskId, roleSlug)` so the two helpers cannot collide on a
 * shared base workspace.
 */
export function provisionedWorktreeBranchName(taskId: string): string {
  return `${HW_WORKTREE_BRANCH_PREFIX}${sanitizeBranchPart(taskId)}`;
}

function defaultLog(level: "info" | "warn", message: string): void {
  if (level === "warn") {
    console.warn(`[provisionWorktree] ${message}`);
  } else {
    console.log(`[provisionWorktree] ${message}`);
  }
}

async function runPersist(
  persist: ProvisionWorktreeDeps["persist"],
  metadata: WorktreeProvisionMetadata,
): Promise<boolean> {
  if (!persist) return false;
  await persist(metadata);
  return true;
}

/**
 * Tightly-focused worktree provisioning helper used by the dispatcher /
 * data-layer seam. Unlike `provisionTaskWorkspace`, this helper takes only a
 * task id and base workspace path so it can be reused by call sites that do
 * not own a full SessionContext (supervisor verification, future test
 * harnesses, etc.). Not yet wired into the adapter spawn path — see goal
 * brief 2026-05-01 (per-agent worktree isolation).
 *
 * Behavior:
 *   - null/empty `baseWorkspace`         → status "disabled"
 *   - existing non-git `baseWorkspace`   → status "skipped"
 *   - git work tree                      → create or reuse
 *                                          `<canonicalRoot>/.claude/worktrees/<taskId>`
 *                                          on a deterministic
 *                                          `hw/worktree/<sanitized-task-id>` branch
 *
 * Distinct task ids under the same base map to distinct worktree paths and
 * distinct branch names by construction.
 */
export async function provisionWorktree(
  taskId: string,
  baseWorkspace: string | null | undefined,
  deps: ProvisionWorktreeDeps = {},
): Promise<WorktreeProvisionResult> {
  const log = deps.log ?? defaultLog;

  if (deps.gitBackedProject !== true) {
    const reason = "Worktree isolation disabled: task is not associated with a git-backed project (projects.git_repo=true).";
    const metadata: WorktreeProvisionMetadata = {
      taskId,
      status: "disabled",
      baseWorkspace: typeof baseWorkspace === "string" && baseWorkspace.trim() ? baseWorkspace.trim() : null,
      worktreePath: null,
      branchName: null,
      reused: false,
      reason,
    };
    log("info", `task ${taskId}: ${reason}`);
    const persisted = await runPersist(deps.persist, metadata);
    return { ...metadata, metadataPersisted: persisted };
  }

  const trimmedBase = typeof baseWorkspace === "string" ? baseWorkspace.trim() : "";
  if (!trimmedBase) {
    const reason = "Base workspace path is null or empty; worktree isolation disabled.";
    const metadata: WorktreeProvisionMetadata = {
      taskId,
      status: "disabled",
      baseWorkspace: null,
      worktreePath: null,
      branchName: null,
      reused: false,
      reason,
    };
    log("warn", `task ${taskId}: ${reason}`);
    const persisted = await runPersist(deps.persist, metadata);
    return { ...metadata, metadataPersisted: persisted };
  }

  if (!(await isGitWorkTree(trimmedBase))) {
    const reason = `Base workspace is not a git work tree: ${trimmedBase}`;
    const metadata: WorktreeProvisionMetadata = {
      taskId,
      status: "skipped",
      baseWorkspace: trimmedBase,
      worktreePath: null,
      branchName: null,
      reused: false,
      reason,
    };
    log("warn", `task ${taskId}: ${reason}`);
    const persisted = await runPersist(deps.persist, metadata);
    return { ...metadata, metadataPersisted: persisted };
  }

  const canonicalRoot = (await git(["rev-parse", "--show-toplevel"], trimmedBase)).stdout;
  const branchName = provisionedWorktreeBranchName(taskId);
  const worktreePath = taskWorktreePath(canonicalRoot, taskId);
  const reused = await pathExists(worktreePath);

  if (!reused) {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const addArgs = (await branchExists(canonicalRoot, branchName))
      ? ["worktree", "add", worktreePath, branchName]
      : ["worktree", "add", worktreePath, "-b", branchName, "HEAD"];
    await git(addArgs, canonicalRoot);
  }

  const metadata: WorktreeProvisionMetadata = {
    taskId,
    status: "active",
    baseWorkspace: canonicalRoot,
    worktreePath,
    branchName,
    reused,
    reason: null,
  };

  // Persistence MUST complete before the helper returns success — downstream
  // consumers (supervisor verification, doctor) read the metadata row to
  // resolve the agent's effective workspace.
  const persisted = await runPersist(deps.persist, metadata);
  return { ...metadata, metadataPersisted: persisted };
}

export async function provisionTaskWorkspace(
  sql: Sql,
  ctx: SessionContext,
): Promise<ProvisionTaskWorkspaceResult> {
  const baseWorkspacePath = ctx.projectWorkspace;
  ctx.baseProjectWorkspace = baseWorkspacePath;

  if (ctx.gitBackedProject !== true) {
    return skipped(
      sql,
      ctx,
      "Worktree isolation disabled: task is not associated with a git-backed project (projects.git_repo=true).",
      baseWorkspacePath,
    );
  }

  const existing = await loadExistingTaskWorkspace(sql, ctx);
  if (existing) return existing;

  if (!baseWorkspacePath) {
    return skipped(sql, ctx, "No workspace path resolved for task; isolation disabled.", null);
  }

  let stat;
  try {
    stat = await fs.stat(baseWorkspacePath);
  } catch {
    return skipped(sql, ctx, `Workspace path does not exist: ${baseWorkspacePath}`, baseWorkspacePath);
  }
  if (!stat.isDirectory()) {
    return skipped(sql, ctx, `Workspace path is not a directory: ${baseWorkspacePath}`, baseWorkspacePath);
  }

  if (!(await isGitWorkTree(baseWorkspacePath))) {
    return skipped(sql, ctx, `Workspace is not a git work tree: ${baseWorkspacePath}`, baseWorkspacePath);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = (await git(["rev-parse", "--show-toplevel"], baseWorkspacePath)).stdout;
  } catch (err) {
    return skipped(sql, ctx, `Unable to resolve git root: ${err instanceof Error ? err.message : String(err)}`, baseWorkspacePath);
  }

  const branchName = taskBranchName(ctx.task.id, ctx.task.assignedTo);
  const worktreePath = taskWorktreePath(canonicalRoot, ctx.task.id);

  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const exists = await pathExists(worktreePath);
    if (exists) {
      const metadata: TaskWorkspaceIsolationContext = {
        status: "active",
        baseWorkspacePath: canonicalRoot,
        worktreePath,
        branchName,
        isolationActive: true,
        reused: true,
        reason: null,
      };
      await persistTaskWorkspace(sql, ctx, metadata);
      return applyIsolationContext(ctx, metadata);
    }

    const addArgs = (await branchExists(canonicalRoot, branchName))
      ? ["worktree", "add", worktreePath, branchName]
      : ["worktree", "add", worktreePath, "-b", branchName, "HEAD"];
    await git(addArgs, canonicalRoot);
    const metadata: TaskWorkspaceIsolationContext = {
      status: "active",
      baseWorkspacePath: canonicalRoot,
      worktreePath,
      branchName,
      isolationActive: true,
      reused: false,
      reason: null,
    };
    await persistTaskWorkspace(sql, ctx, metadata);
    return applyIsolationContext(ctx, metadata);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failed(sql, ctx, msg.slice(0, 2000), canonicalRoot, worktreePath, branchName);
  }
}
