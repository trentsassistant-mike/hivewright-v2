import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hiveGoalWorkspacePath,
  hiveProjectsPath,
  resolveHiveWorkspaceRoot,
} from "@/hives/workspace-root";

const originalRoot = process.env.HIVES_WORKSPACE_ROOT;

afterEach(() => {
  if (originalRoot === undefined) delete process.env.HIVES_WORKSPACE_ROOT;
  else process.env.HIVES_WORKSPACE_ROOT = originalRoot;
});

describe("hive workspace root", () => {
  it("defaults to ~/hives when HIVES_WORKSPACE_ROOT is unset", () => {
    delete process.env.HIVES_WORKSPACE_ROOT;

    expect(resolveHiveWorkspaceRoot()).toBe(path.join(os.homedir(), "hives"));
    expect(hiveProjectsPath("demo-hive")).toBe(
      path.join(os.homedir(), "hives", "demo-hive", "projects"),
    );
  });

  it("uses HIVES_WORKSPACE_ROOT when set", () => {
    process.env.HIVES_WORKSPACE_ROOT = "/tmp/hw-hives";

    expect(resolveHiveWorkspaceRoot()).toBe("/tmp/hw-hives");
    expect(hiveProjectsPath("demo-hive")).toBe("/tmp/hw-hives/demo-hive/projects");
    expect(hiveGoalWorkspacePath("demo-hive", "1234567890abcdef")).toBe(
      "/tmp/hw-hives/demo-hive/goals/12345678",
    );
  });
});
