import os from "os";
import path from "path";

export const HIVES_WORKSPACE_ROOT_ENV = "HIVES_WORKSPACE_ROOT";

export function resolveHiveWorkspaceRoot(
  env: { [key: string]: string | undefined } = process.env,
): string {
  return path.resolve(env.HIVES_WORKSPACE_ROOT ?? path.join(os.homedir(), "hives"));
}

export function hiveRootPath(slug: string): string {
  return path.join(resolveHiveWorkspaceRoot(), slug);
}

export function hiveProjectsPath(slug: string): string {
  return path.join(hiveRootPath(slug), "projects");
}

export function hiveGoalWorkspacePath(slug: string, goalId: string): string {
  return path.join(hiveRootPath(slug), "goals", goalId.slice(0, 8));
}
