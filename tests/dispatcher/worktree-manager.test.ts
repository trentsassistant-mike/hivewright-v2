import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inheritTaskWorkspaceFromParent,
  provisionTaskWorkspace,
  taskBranchName,
  taskWorktreePath,
} from "@/dispatcher/worktree-manager";
import { buildSessionContext } from "@/dispatcher/session-builder";
import { syncRoleLibrary } from "@/roles/sync";
import type { SessionContext } from "@/adapters/types";
import type { ClaimedTask } from "@/dispatcher/types";
import { seedTestModelRoutingForHive, testSql as sql, truncateAll } from "../_lib/test-db";

let tempDirs: string[] = [];
let hiveId: string;

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createTempRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hw-worktree-test-"));
  tempDirs.push(repo);
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "test@hivewright.local"]);
  runGit(repo, ["config", "user.name", "HiveWright Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial commit"]);
  return repo;
}

function task(overrides: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    hiveId,
    assignedTo: overrides.assignedTo ?? "dev-agent",
    createdBy: "owner",
    status: "active",
    priority: 5,
    title: "Worktree fixture task",
    brief: "Make an isolated change.",
    parentTaskId: null,
    goalId: null,
    sprintNumber: null,
    qaRequired: false,
    acceptanceCriteria: null,
    retryCount: 0,
    doctorAttempts: 0,
    failureReason: null,
    adapterOverride: null,
    modelOverride: null,
    projectId: null,
    ...overrides,
  };
}

function context(taskRow: ClaimedTask, workspace: string | null, gitBackedProject = false): SessionContext {
  return {
    task: taskRow,
    roleTemplate: {
      slug: taskRow.assignedTo,
      department: "engineering",
      roleMd: null,
      soulMd: null,
      toolsMd: null,
    },
    memoryContext: {
      roleMemory: [],
      hiveMemory: [],
      insights: [],
      capacity: "0/200",
    },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: workspace,
    gitBackedProject,
    baseProjectWorkspace: workspace,
    hiveWorkspacePath: workspace,
    model: "anthropic/claude-sonnet-4-6",
    fallbackModel: null,
    credentials: {},
  };
}

async function insertTask(taskRow: ClaimedTask): Promise<void> {
  await sql`
    INSERT INTO tasks (
      id, hive_id, assigned_to, created_by, status, priority, title, brief,
      parent_task_id, goal_id, sprint_number, qa_required, acceptance_criteria,
      retry_count, doctor_attempts, failure_reason
    )
    VALUES (
      ${taskRow.id}, ${taskRow.hiveId}, ${taskRow.assignedTo}, ${taskRow.createdBy},
      ${taskRow.status}, ${taskRow.priority}, ${taskRow.title}, ${taskRow.brief},
      ${taskRow.parentTaskId}, ${taskRow.goalId}, ${taskRow.sprintNumber},
      ${taskRow.qaRequired}, ${taskRow.acceptanceCriteria}, ${taskRow.retryCount},
      ${taskRow.doctorAttempts}, ${taskRow.failureReason}
    )
  `;
}

beforeEach(async () => {
  await truncateAll(sql);
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);
  const [hive] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES ('worktree-manager-test', 'Worktree Manager Test', 'digital', '/tmp')
    RETURNING id
  `;
  hiveId = hive.id;
  await seedTestModelRoutingForHive(hiveId, sql);
});

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("provisionTaskWorkspace", () => {
  it("assigns distinct worktree paths and branches to two tasks sharing one base repo", async () => {
    const repo = createTempRepo();
    const taskA = task({ id: "10000000-0000-0000-0000-000000000001" });
    const taskB = task({ id: "20000000-0000-0000-0000-000000000002" });
    await insertTask(taskA);
    await insertTask(taskB);

    const ctxA = context(taskA, repo, true);
    const ctxB = context(taskB, repo, true);
    const resultA = await provisionTaskWorkspace(sql, ctxA);
    const resultB = await provisionTaskWorkspace(sql, ctxB);

    expect(resultA.status).toBe("active");
    expect(resultB.status).toBe("active");
    expect(resultA.worktreePath).toBe(taskWorktreePath(repo, taskA.id));
    expect(resultB.worktreePath).toBe(taskWorktreePath(repo, taskB.id));
    expect(resultA.worktreePath).not.toBe(resultB.worktreePath);
    expect(resultA.branchName).toBe(taskBranchName(taskA.id, "dev-agent"));
    expect(resultB.branchName).toBe(taskBranchName(taskB.id, "dev-agent"));
    expect(resultA.branchName).not.toBe(resultB.branchName);
    expect(fs.existsSync(resultA.worktreePath!)).toBe(true);
    expect(fs.existsSync(resultB.worktreePath!)).toBe(true);
  });

  it("passes the worktree as effective workspace while preserving base metadata", async () => {
    const repo = createTempRepo();
    const taskRow = task({ id: "30000000-0000-0000-0000-000000000003" });
    await insertTask(taskRow);
    const ctx = context(taskRow, repo, true);

    const result = await provisionTaskWorkspace(sql, ctx);

    expect(result.status).toBe("active");
    expect(ctx.projectWorkspace).toBe(taskWorktreePath(repo, taskRow.id));
    expect(ctx.baseProjectWorkspace).toBe(repo);
    expect(ctx.workspaceIsolation).toMatchObject({
      isolationActive: true,
      baseWorkspacePath: repo,
      worktreePath: taskWorktreePath(repo, taskRow.id),
    });
    const [row] = await sql`
      SELECT base_workspace_path, worktree_path, branch_name, isolation_status, isolation_active
      FROM task_workspaces
      WHERE task_id = ${taskRow.id}
    `;
    expect(row).toMatchObject({
      base_workspace_path: repo,
      worktree_path: taskWorktreePath(repo, taskRow.id),
      branch_name: taskBranchName(taskRow.id, "dev-agent"),
      isolation_status: "active",
      isolation_active: true,
    });
  });

  it("honors a pre-seeded inherited workspace row instead of provisioning a child worktree", async () => {
    const repo = createTempRepo();
    const parent = task({ id: "31000000-0000-0000-0000-000000000031" });
    const child = task({
      id: "32000000-0000-0000-0000-000000000032",
      assignedTo: "qa",
      parentTaskId: parent.id,
    });
    await insertTask(parent);
    await insertTask(child);

    const parentCtx = context(parent, repo, true);
    const parentResult = await provisionTaskWorkspace(sql, parentCtx);
    const inherited = await inheritTaskWorkspaceFromParent(sql, parent.id, child.id);
    const childCtx = context(child, repo, true);
    const childResult = await provisionTaskWorkspace(sql, childCtx);

    expect(inherited).toBe(true);
    expect(childResult).toMatchObject({
      status: "active",
      worktreePath: parentResult.worktreePath,
      branchName: parentResult.branchName,
      reused: true,
    });
    expect(childCtx.projectWorkspace).toBe(parentResult.worktreePath);
    expect(fs.existsSync(taskWorktreePath(repo, child.id))).toBe(false);
  });

  it("provisions an active task_workspaces row from a project-scoped task when hive workspace is null", async () => {
    const repo = createTempRepo();
    await sql`UPDATE hives SET workspace_path = NULL WHERE id = ${hiveId}`;
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (hive_id, slug, name, workspace_path, git_repo)
      VALUES (${hiveId}, 'app', 'App', ${repo}, true)
      RETURNING id
    `;
    const taskRow = task({
      id: "60000000-0000-0000-0000-000000000006",
      projectId: project.id,
    });
    await sql`
      INSERT INTO tasks (
        id, hive_id, assigned_to, created_by, status, priority, title, brief,
        project_id, retry_count, doctor_attempts
      )
      VALUES (
        ${taskRow.id}, ${taskRow.hiveId}, ${taskRow.assignedTo}, ${taskRow.createdBy},
        ${taskRow.status}, ${taskRow.priority}, ${taskRow.title}, ${taskRow.brief},
        ${taskRow.projectId}, ${taskRow.retryCount}, ${taskRow.doctorAttempts}
      )
    `;

    const ctx = await buildSessionContext(sql, taskRow);
    const result = await provisionTaskWorkspace(sql, ctx);

    expect(ctx.baseProjectWorkspace).toBe(repo);
    expect(result.status).toBe("active");
    const [row] = await sql`
      SELECT isolation_status, isolation_active, skipped_reason
      FROM task_workspaces
      WHERE task_id = ${taskRow.id}
    `;
    expect(row).toMatchObject({
      isolation_status: "active",
      isolation_active: true,
      skipped_reason: null,
    });
  });

  it("does not provision a worktree for a task without a project even when the hive workspace is a git repo", async () => {
    const repo = createTempRepo();
    await sql`UPDATE hives SET workspace_path = ${repo} WHERE id = ${hiveId}`;
    const taskRow = task({ id: "61000000-0000-0000-0000-000000000061", projectId: null });
    await insertTask(taskRow);

    const ctx = await buildSessionContext(sql, taskRow);
    const result = await provisionTaskWorkspace(sql, ctx);

    expect(ctx.projectWorkspace).toBe(repo);
    expect(ctx.gitBackedProject).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.isolationActive).toBe(false);
    expect(result.reason).toContain("git-backed project");
    expect(fs.existsSync(taskWorktreePath(repo, taskRow.id))).toBe(false);
  });

  it("does not provision a worktree for a project with git_repo=false even when its workspace is a git repo", async () => {
    const repo = createTempRepo();
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (hive_id, slug, name, workspace_path, git_repo)
      VALUES (${hiveId}, 'docs', 'Docs', ${repo}, false)
      RETURNING id
    `;
    const taskRow = task({
      id: "62000000-0000-0000-0000-000000000062",
      projectId: project.id,
    });
    await sql`
      INSERT INTO tasks (
        id, hive_id, assigned_to, created_by, status, priority, title, brief,
        project_id, retry_count, doctor_attempts
      )
      VALUES (
        ${taskRow.id}, ${taskRow.hiveId}, ${taskRow.assignedTo}, ${taskRow.createdBy},
        ${taskRow.status}, ${taskRow.priority}, ${taskRow.title}, ${taskRow.brief},
        ${taskRow.projectId}, ${taskRow.retryCount}, ${taskRow.doctorAttempts}
      )
    `;

    const ctx = await buildSessionContext(sql, taskRow);
    const result = await provisionTaskWorkspace(sql, ctx);

    expect(ctx.projectWorkspace).toBe(repo);
    expect(ctx.gitBackedProject).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.isolationActive).toBe(false);
    expect(result.reason).toContain("git-backed project");
    expect(fs.existsSync(taskWorktreePath(repo, taskRow.id))).toBe(false);
  });

  it("records skipped isolation for null and non-git workspaces", async () => {
    const nullWorkspaceTask = task({ id: "40000000-0000-0000-0000-000000000004" });
    const nonGitTask = task({ id: "50000000-0000-0000-0000-000000000005" });
    await insertTask(nullWorkspaceTask);
    await insertTask(nonGitTask);
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-non-git-"));
    tempDirs.push(nonGitDir);

    const nullResult = await provisionTaskWorkspace(sql, context(nullWorkspaceTask, null, true));
    const nonGitResult = await provisionTaskWorkspace(sql, context(nonGitTask, nonGitDir, true));

    expect(nullResult).toMatchObject({
      status: "skipped",
      isolationActive: false,
      reason: "No workspace path resolved for task; isolation disabled.",
    });
    expect(nonGitResult.status).toBe("skipped");
    expect(nonGitResult.isolationActive).toBe(false);
    expect(nonGitResult.reason).toContain("Workspace is not a git work tree");

    const rows = await sql`
      SELECT task_id, isolation_status, isolation_active, skipped_reason
      FROM task_workspaces
      WHERE task_id IN (${nullWorkspaceTask.id}, ${nonGitTask.id})
      ORDER BY task_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.isolation_status === "skipped")).toBe(true);
    expect(rows.every((row) => row.isolation_active === false)).toBe(true);
    expect(rows.map((row) => row.skipped_reason).join("\n")).toContain("No workspace path resolved");
    expect(rows.map((row) => row.skipped_reason).join("\n")).toContain("not a git work tree");
  });
});
