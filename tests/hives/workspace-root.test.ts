import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hiveGoalWorkspacePath,
  hiveProjectsPath,
  resolveHiveWorkspaceRoot,
} from "@/hives/workspace-root";

const originalRoot = process.env.HIVES_WORKSPACE_ROOT;
const originalRuntimeRoot = process.env.HIVEWRIGHT_RUNTIME_ROOT;

afterEach(() => {
  if (originalRoot === undefined) delete process.env.HIVES_WORKSPACE_ROOT;
  else process.env.HIVES_WORKSPACE_ROOT = originalRoot;

  if (originalRuntimeRoot === undefined) delete process.env.HIVEWRIGHT_RUNTIME_ROOT;
  else process.env.HIVEWRIGHT_RUNTIME_ROOT = originalRuntimeRoot;
});

describe("hive workspace root", () => {
  it("defaults to ~/.hivewright/hives when HIVES_WORKSPACE_ROOT is unset", () => {
    delete process.env.HIVES_WORKSPACE_ROOT;
    delete process.env.HIVEWRIGHT_RUNTIME_ROOT;

    expect(resolveHiveWorkspaceRoot()).toBe(path.join(os.homedir(), ".hivewright", "hives"));
    expect(hiveProjectsPath("demo-hive")).toBe(
      path.join(os.homedir(), ".hivewright", "hives", "demo-hive", "projects"),
    );
  });

  it("uses HIVEWRIGHT_RUNTIME_ROOT as the base default when set", () => {
    delete process.env.HIVES_WORKSPACE_ROOT;
    process.env.HIVEWRIGHT_RUNTIME_ROOT = "/srv/hivewright/runtime";

    expect(resolveHiveWorkspaceRoot()).toBe("/srv/hivewright/runtime/hives");
  });

  it("uses HIVES_WORKSPACE_ROOT when set", () => {
    process.env.HIVES_WORKSPACE_ROOT = "/tmp/hw-hives";

    expect(resolveHiveWorkspaceRoot()).toBe("/tmp/hw-hives");
    expect(hiveProjectsPath("demo-hive")).toBe("/tmp/hw-hives/demo-hive/projects");
    expect(hiveGoalWorkspacePath("demo-hive", "1234567890abcdef")).toBe(
      "/tmp/hw-hives/demo-hive/goals/12345678",
    );
  });

  it("rejects workspace roots inside the software repo", () => {
    expect(() => resolveHiveWorkspaceRoot({ HIVES_WORKSPACE_ROOT: "/opt/hivewright/app/hives" }, "/opt/hivewright/app")).toThrow(/outside the HiveWright software repository/);
  });
});
