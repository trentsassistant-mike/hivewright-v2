import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  buildUpdatePlan,
  parseUpdateStatus,
  type UpdatePlan,
  type UpdateStatus,
} from "./update";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

export type UpdateRuntimeOptions = {
  cwd?: string;
  fetch?: boolean;
};

export type UpdateCommandResult = {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
};

export type ApplyUpdateOptions = {
  cwd?: string;
  restart?: boolean;
  onResult?: (result: UpdateCommandResult) => void;
};

async function readPackageVersion(cwd: string) {
  const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

async function runGit(cwd: string, args: string[], timeout = DEFAULT_TIMEOUT_MS) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function safeRemoteUrl(remoteUrl: string | null) {
  if (!remoteUrl) return null;
  return remoteUrl.replace(/(https?:\/\/)[^/@:]+:[^/@]+@/i, "$1");
}

async function optionalGit(cwd: string, args: string[]) {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

export async function getUpdateStatus(options: UpdateRuntimeOptions = {}): Promise<UpdateStatus> {
  const cwd = options.cwd ?? process.cwd();
  const packageVersion = await readPackageVersion(cwd);

  if (options.fetch) {
    await optionalGit(cwd, ["fetch", "--tags"]);
  }

  const [currentCommit, remoteUrl, branch, dirtyOutput, upstreamRef] = await Promise.all([
    optionalGit(cwd, ["rev-parse", "HEAD"]),
    optionalGit(cwd, ["remote", "get-url", "origin"]),
    optionalGit(cwd, ["branch", "--show-current"]),
    optionalGit(cwd, ["status", "--porcelain"]),
    optionalGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);

  const upstreamCommit = upstreamRef
    ? await optionalGit(cwd, ["rev-parse", upstreamRef])
    : null;

  return parseUpdateStatus({
    packageVersion,
    currentCommit,
    upstreamCommit,
    remoteUrl: safeRemoteUrl(remoteUrl),
    branch,
    dirty: Boolean(dirtyOutput),
  });
}

const UPDATE_COMMANDS: Record<string, { command: string; args: string[] }> = {
  "git pull --ff-only": { command: "git", args: ["pull", "--ff-only"] },
  "npm install": { command: "npm", args: ["install"] },
  "npm run db:migrate:app": { command: "npm", args: ["run", "db:migrate:app"] },
  "npm run build": { command: "npm", args: ["run", "build"] },
  "systemctl --user restart hivewright-dashboard hivewright-dispatcher": {
    command: "systemctl",
    args: ["--user", "restart", "hivewright-dashboard", "hivewright-dispatcher"],
  },
};

async function runUpdateCommand(cwd: string, commandText: string): Promise<UpdateCommandResult> {
  const spec = UPDATE_COMMANDS[commandText];
  if (!spec) {
    return {
      command: commandText,
      code: 1,
      stdout: "",
      stderr: `Unsupported update command: ${commandText}`,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
      cwd,
      timeout: 10 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { command: commandText, code: 0, stdout, stderr };
  } catch (error) {
    const err = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      command: commandText,
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
    };
  }
}

export async function applyUpdate(options: ApplyUpdateOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const status = await getUpdateStatus({ cwd, fetch: true });
  const plan = buildUpdatePlan(status, { apply: true, restart: options.restart });
  const results: UpdateCommandResult[] = [];

  if (!plan.allowed) {
    return { status, plan, results };
  }

  for (const command of plan.commands) {
    const result = await runUpdateCommand(cwd, command);
    results.push(result);
    options.onResult?.(result);
    if (result.code !== 0) break;
  }

  return { status, plan, results };
}

export function getUpdatePlan(status: UpdateStatus, restart = true): UpdatePlan {
  return buildUpdatePlan(status, { apply: true, restart });
}
