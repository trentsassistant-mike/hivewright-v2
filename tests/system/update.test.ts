import { describe, expect, it } from "vitest";
import {
  buildUpdatePlan,
  parseUpdateStatus,
  type GitUpdateSnapshot,
} from "@/system/update";

describe("HiveWright update system", () => {
  it("reports the app version from package metadata", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
    });

    expect(status.currentVersion).toBe("1.2.3");
    expect(status.updateAvailable).toBe(true);
    expect(status.state).toBe("update-available");
  });

  it("marks a clean checkout current when local and upstream commits match", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "abc1234",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
    });

    expect(status.updateAvailable).toBe(false);
    expect(status.state).toBe("current");
  });

  it("blocks automatic update when the install has local changes", () => {
    const snapshot: GitUpdateSnapshot = {
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: true,
    };

    const status = parseUpdateStatus(snapshot);
    const plan = buildUpdatePlan(status, { apply: true });

    expect(status.state).toBe("blocked-dirty-worktree");
    expect(plan.allowed).toBe(false);
    expect(plan.commands).toEqual([]);
  });

  it("builds a normal self-hosted update command plan", () => {
    const status = parseUpdateStatus({
      packageVersion: "1.2.3",
      currentCommit: "abc1234",
      upstreamCommit: "def5678",
      remoteUrl: "https://github.com/example/hivewright-v2.git",
      branch: "main",
      dirty: false,
    });

    const plan = buildUpdatePlan(status, { apply: true, restart: true });

    expect(plan.allowed).toBe(true);
    expect(plan.commands).toEqual([
      "git pull --ff-only",
      "npm install",
      "npm run db:migrate:app",
      "npm run build",
      "systemctl --user restart hivewright-dashboard hivewright-dispatcher",
    ]);
  });
});
