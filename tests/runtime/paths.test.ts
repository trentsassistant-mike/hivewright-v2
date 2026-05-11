import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  HIVEWRIGHT_ENV_FILE_ENV,
  HIVEWRIGHT_RUNTIME_ROOT_ENV,
  assertOutsideRepo,
  resolveHivewrightEnvFilePath,
  resolveHivewrightRuntimeRoot,
  resolveRuntimePath,
} from "@/runtime/paths";

describe("HiveWright runtime paths", () => {
  it("defaults runtime state outside the software repo", () => {
    const repoRoot = "/opt/hivewright/app";
    const env: Record<string, string | undefined> = {};

    expect(resolveHivewrightRuntimeRoot(env, repoRoot)).toBe(path.join(os.homedir(), ".hivewright"));
    expect(resolveRuntimePath(["hives"], env, repoRoot)).toBe(path.join(os.homedir(), ".hivewright", "hives"));
    expect(resolveHivewrightEnvFilePath(env, repoRoot)).toBe(path.join(os.homedir(), ".hivewright", "config", ".env"));
  });

  it("allows explicit external runtime and env paths", () => {
    const repoRoot = "/opt/hivewright/app";
    const env = {
      [HIVEWRIGHT_RUNTIME_ROOT_ENV]: "/srv/hivewright/runtime",
      [HIVEWRIGHT_ENV_FILE_ENV]: "/etc/hivewright/hivewright.env",
    };

    expect(resolveHivewrightRuntimeRoot(env, repoRoot)).toBe("/srv/hivewright/runtime");
    expect(resolveHivewrightEnvFilePath(env, repoRoot)).toBe("/etc/hivewright/hivewright.env");
  });

  it("rejects runtime paths inside the software repo", () => {
    const repoRoot = "/opt/hivewright/app";

    expect(() => assertOutsideRepo("/opt/hivewright/app/runtime", repoRoot)).toThrow(/outside the HiveWright software repository/);
    expect(() => resolveHivewrightRuntimeRoot({ [HIVEWRIGHT_RUNTIME_ROOT_ENV]: "/opt/hivewright/app/.runtime" }, repoRoot)).toThrow(/outside the HiveWright software repository/);
    expect(() => resolveHivewrightEnvFilePath({ [HIVEWRIGHT_ENV_FILE_ENV]: "/opt/hivewright/app/.env" }, repoRoot)).toThrow(/outside the HiveWright software repository/);
  });
});
