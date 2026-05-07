import { spawn } from "child_process";
import type { Provisioner, ProvisionProgress, ProvisionStatus, ProvisionerInput } from "./types";

export class GeminiProvisioner implements Provisioner {
  async check(input: ProvisionerInput): Promise<ProvisionStatus> {
    void input;
    const reachable = await geminiBinaryReachable();
    if (!reachable) {
      return {
        satisfied: false,
        fixable: false,
        reason: "gemini CLI not found on PATH - install with `npm install -g @google/gemini-cli` and configure GEMINI_API_KEY, Vertex/ADC, GCA, or OAuth.",
      };
    }
    return { satisfied: true, fixable: false };
  }

  async *provision(input: ProvisionerInput): AsyncGenerator<ProvisionProgress> {
    yield { phase: "done", status: await this.check(input) };
  }
}

function geminiBinaryReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("gemini", ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    let resolved = false;
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        resolve(code === 0);
      }
    });
    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });
}
