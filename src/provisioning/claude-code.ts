import { spawn } from "child_process";
import type { Provisioner, ProvisionProgress, ProvisionStatus, ProvisionerInput } from "./types";

const MIN_CLAUDE_CODE_VERSION = "2.1.138";

export class ClaudeCodeProvisioner implements Provisioner {
  async check(input: ProvisionerInput): Promise<ProvisionStatus> {
    void input;
    const detectedVersion = await detectClaudeCodeVersion();
    if (!detectedVersion.reachable) {
      return {
        satisfied: false,
        fixable: false,
        reason: "claude CLI not found on PATH or failed to report its version. Install/upgrade the managed Claude Code runtime to 2.1.138 or newer.",
      };
    }
    if (!detectedVersion.version) {
      return {
        satisfied: false,
        fixable: false,
        reason: `claude CLI returned an unreadable version string. Expected Claude Code ${MIN_CLAUDE_CODE_VERSION}+ readiness evidence.`,
      };
    }
    if (compareVersions(detectedVersion.version, MIN_CLAUDE_CODE_VERSION) < 0) {
      return {
        satisfied: false,
        fixable: false,
        reason: `claude CLI ${detectedVersion.version} is below the required Claude Code ${MIN_CLAUDE_CODE_VERSION}. Upgrade the managed runtime before dispatching Claude tasks.`,
      };
    }
    return { satisfied: true, fixable: false };
  }

  async *provision(input: ProvisionerInput): AsyncGenerator<ProvisionProgress> {
    yield { phase: "done", status: await this.check(input) };
  }
}

function detectClaudeCodeVersion(): Promise<{ reachable: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    let stdout = "";
    let stderr = "";
    let resolved = false;

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    proc.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      const text = `${stdout}\n${stderr}`;
      resolve({
        reachable: code === 0,
        version: parseVersion(text),
      });
    });

    proc.on("error", () => {
      if (resolved) return;
      resolved = true;
      resolve({ reachable: false, version: null });
    });
  });
}

function parseVersion(text: string): string | null {
  const match = text.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}
