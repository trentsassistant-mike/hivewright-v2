/**
 * Tests for `provisionWorktree(taskId, baseWorkspace)` — the focused
 * dispatcher/data-layer helper used to provision (or reuse) a per-task git
 * worktree for HiveWright agent isolation.
 *
 * This helper is intentionally narrower than `provisionTaskWorkspace` (which
 * takes a full SessionContext + Sql): it accepts only a task id and a base
 * workspace path and is wired in by callers (dispatcher spawn path, future
 * supervisor checks, etc.) that have not been adapted yet. These tests pin
 * the contract that future wiring depends on.
 *
 * Covers:
 *   1. Two distinct task IDs under the same git base workspace map to distinct
 *      `.claude/worktrees/<task-id>` paths and distinct branch names.
 *   2. Null base workspace returns status `disabled` with an explicit reason.
 *   3. Empty string base workspace returns status `disabled` with an explicit reason.
 *   4. Non-git directory returns status `skipped` with an explicit reason.
 *   5. Metadata persistence completes before the helper returns on the
 *      git-backed success path (proven via ordering of awaited persist).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  HW_WORKTREE_BRANCH_PREFIX,
  provisionWorktree,
  provisionedWorktreeBranchName,
} from "./worktree-manager";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function makeTempGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hw-prov-test-"));
  tempDirs.push(dir);
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@hw.local"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "HW Test"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir });
  return dir;
}

async function makeTempPlainDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hw-prov-plain-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("provisionWorktree", () => {
  it("maps two distinct task IDs under the same git base workspace to distinct .claude/worktrees/<task-id> paths", async () => {
    const base = await makeTempGitRepo();
    const taskA = "task-aaaaaaaa-1111";
    const taskB = "task-bbbbbbbb-2222";

    const persist = vi.fn().mockResolvedValue(undefined);
    const a = await provisionWorktree(taskA, base, { gitBackedProject: true, persist });
    const b = await provisionWorktree(taskB, base, { gitBackedProject: true, persist });

    expect(a.status).toBe("active");
    expect(b.status).toBe("active");
    expect(a.worktreePath).toBe(path.join(base, ".claude", "worktrees", taskA));
    expect(b.worktreePath).toBe(path.join(base, ".claude", "worktrees", taskB));
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branchName).not.toBe(b.branchName);
    expect(a.branchName!.startsWith(HW_WORKTREE_BRANCH_PREFIX)).toBe(true);
    expect(b.branchName!.startsWith(HW_WORKTREE_BRANCH_PREFIX)).toBe(true);
    expect(a.branchName).toBe(provisionedWorktreeBranchName(taskA));
    expect(b.branchName).toBe(provisionedWorktreeBranchName(taskB));
  });

  it("returns status `disabled` with an explicit reason when baseWorkspace is null", async () => {
    const log = vi.fn();
    const persist = vi.fn().mockResolvedValue(undefined);
    const result = await provisionWorktree("task-null", null, { gitBackedProject: true, log, persist });

    expect(result.status).toBe("disabled");
    expect(result.baseWorkspace).toBeNull();
    expect(result.worktreePath).toBeNull();
    expect(result.branchName).toBeNull();
    expect(typeof result.reason).toBe("string");
    expect((result.reason ?? "").length).toBeGreaterThan(0);

    // The explicit reason must be recorded somewhere observable —
    // either persisted to the metadata sink or written to the log.
    const persistedReason = persist.mock.calls.some(
      ([m]) => m && typeof m === "object" && (m as { reason?: string }).reason,
    );
    const loggedReason = log.mock.calls.some(
      (args) => args.some((a) => typeof a === "string" && a.length > 0),
    );
    expect(persistedReason || loggedReason).toBe(true);
  });

  it("returns status `disabled` with an explicit reason when baseWorkspace is an empty string", async () => {
    const log = vi.fn();
    const result = await provisionWorktree("task-empty", "", { gitBackedProject: true, log });

    expect(result.status).toBe("disabled");
    expect(result.baseWorkspace).toBeNull();
    expect(typeof result.reason).toBe("string");
    expect((result.reason ?? "").length).toBeGreaterThan(0);
    expect(log.mock.calls.length).toBeGreaterThan(0);
  });

  it("returns status `skipped` with an explicit reason when baseWorkspace is not a git repository", async () => {
    const plain = await makeTempPlainDir();
    const log = vi.fn();
    const result = await provisionWorktree("task-not-git", plain, { gitBackedProject: true, log });

    expect(result.status).toBe("skipped");
    expect(result.baseWorkspace).toBe(plain);
    expect(result.worktreePath).toBeNull();
    expect(result.branchName).toBeNull();
    expect(typeof result.reason).toBe("string");
    expect((result.reason ?? "").length).toBeGreaterThan(0);
    expect(log.mock.calls.length).toBeGreaterThan(0);
  });

  it("returns status `disabled` without touching git when the caller does not assert an explicit git-backed project", async () => {
    const base = await makeTempGitRepo();
    const log = vi.fn();
    const result = await provisionWorktree("task-policy-gate", base, { log });

    expect(result.status).toBe("disabled");
    expect(result.baseWorkspace).toBe(base);
    expect(result.worktreePath).toBeNull();
    expect(result.branchName).toBeNull();
    expect(typeof result.reason).toBe("string");
    expect(result.reason).toContain("git-backed project");
    expect(log.mock.calls.length).toBeGreaterThan(0);
    await expect(fs.access(path.join(base, ".claude", "worktrees", "task-policy-gate"))).rejects.toThrow();
  });

  it("persists worktree metadata before returning on the git-backed success path", async () => {
    const base = await makeTempGitRepo();

    // Order log: persist completion is pushed inside the persist callback,
    // helper-resolution is pushed by the awaiting `.then` below. If the
    // helper does not await persist, helper-resolution will land first.
    const order: string[] = [];

    const persist = vi.fn().mockImplementation(async (metadata) => {
      // Simulate non-trivial async I/O so an un-awaited persist would
      // demonstrably resolve after the helper.
      await new Promise((r) => setTimeout(r, 25));
      order.push(`persist:${(metadata as { status: string }).status}`);
    });

    const helperPromise = provisionWorktree("task-success-1", base, { gitBackedProject: true, persist }).then(
      (r) => {
        order.push("helper-resolved");
        return r;
      },
    );

    const result = await helperPromise;

    expect(persist).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["persist:active", "helper-resolved"]);
    expect(result.status).toBe("active");
    expect(result.metadataPersisted).toBe(true);

    // The persisted metadata must reflect the same data the caller sees.
    const persistedArg = persist.mock.calls[0][0] as {
      taskId: string;
      status: string;
      worktreePath: string;
      branchName: string;
    };
    expect(persistedArg.taskId).toBe("task-success-1");
    expect(persistedArg.status).toBe("active");
    expect(persistedArg.worktreePath).toBe(result.worktreePath);
    expect(persistedArg.branchName).toBe(result.branchName);
  });
});
