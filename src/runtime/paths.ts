import * as os from "node:os";
import * as path from "node:path";

export const HIVEWRIGHT_RUNTIME_ROOT_ENV = "HIVEWRIGHT_RUNTIME_ROOT";
export const HIVEWRIGHT_ENV_FILE_ENV = "HIVEWRIGHT_ENV_FILE";

export function pathContains(childPath: string, parentPath: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertOutsideRepo(pathname: string, repoRoot = process.cwd(), label = "Runtime path"): string {
  const resolved = path.resolve(pathname);
  const resolvedRepo = path.resolve(repoRoot);

  if (pathContains(resolved, resolvedRepo)) {
    throw new Error(
      `${label} must be outside the HiveWright software repository. Set ${HIVEWRIGHT_RUNTIME_ROOT_ENV} to an external directory.`,
    );
  }

  return resolved;
}

export function resolveHivewrightRuntimeRoot(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
): string {
  const configured = env[HIVEWRIGHT_RUNTIME_ROOT_ENV];
  const defaultRoot = path.join(os.homedir(), ".hivewright");
  return assertOutsideRepo(configured ?? defaultRoot, repoRoot, "HiveWright runtime root");
}

export function resolveRuntimePath(
  segments: string[],
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
): string {
  const runtimeRoot = resolveHivewrightRuntimeRoot(env, repoRoot);
  return assertOutsideRepo(path.join(runtimeRoot, ...segments), repoRoot, "HiveWright runtime path");
}

export function resolveHivewrightEnvFilePath(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
): string {
  const configured = env[HIVEWRIGHT_ENV_FILE_ENV];
  if (configured) return assertOutsideRepo(configured, repoRoot, "HiveWright env file");
  return resolveRuntimePath(["config", ".env"], env, repoRoot);
}
