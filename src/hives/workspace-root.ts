import path from "path";
import { resolveHivewrightRuntimeRoot, assertOutsideRepo } from "@/runtime/paths";

export const HIVES_WORKSPACE_ROOT_ENV = "HIVES_WORKSPACE_ROOT";

export function resolveHiveWorkspaceRoot(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
): string {
  const configured = env.HIVES_WORKSPACE_ROOT;
  const root = configured ?? path.join(resolveHivewrightRuntimeRoot(env, repoRoot), "hives");
  return assertOutsideRepo(path.resolve(root), repoRoot, "Hive workspace root");
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
