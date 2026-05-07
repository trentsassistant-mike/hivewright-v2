import { spawn } from "child_process";
import type { Provisioner, ProvisionProgress, ProvisionStatus, ProvisionerInput } from "./types";

/**
 * Codex CLI provisioner. The codex binary is owner-installed (npm global) and
 * authenticated via `codex login` (writes ~/.codex/auth.json with
 * auth_mode="chatgpt" for subscription billing). Treat as satisfied when the
 * binary is reachable on PATH; otherwise flag for owner intervention.
 */
export class CodexProvisioner implements Provisioner {
  async check(input: ProvisionerInput): Promise<ProvisionStatus> {
    if (!isCodexCompatibleModel(input.recommendedModel)) {
      return {
        satisfied: false,
        fixable: false,
        reason: `Model ${input.recommendedModel} is not supported by the Codex ChatGPT-account runtime.`,
      };
    }

    const reachable = await codexBinaryReachable();
    if (!reachable) {
      return {
        satisfied: false,
        fixable: false,
        reason: "codex CLI not found on PATH — install with `npm i -g @openai/codex` and run `codex login`.",
      };
    }
    return { satisfied: true, fixable: false };
  }

  async *provision(input: ProvisionerInput): AsyncGenerator<ProvisionProgress> {
    yield { phase: "done", status: await this.check(input) };
  }
}

export function isCodexCompatibleModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return model.startsWith("openai-codex/");
}

function codexBinaryReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    let resolved = false;
    proc.on("close", (code) => { if (!resolved) { resolved = true; resolve(code === 0); } });
    proc.on("error", () => { if (!resolved) { resolved = true; resolve(false); } });
  });
}
