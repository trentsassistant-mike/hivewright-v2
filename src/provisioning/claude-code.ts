import type { Provisioner, ProvisionProgress, ProvisionStatus, ProvisionerInput } from "./types";

export class ClaudeCodeProvisioner implements Provisioner {
  async check(input: ProvisionerInput): Promise<ProvisionStatus> {
    void input;
    return { satisfied: true, fixable: true };
  }

  async *provision(input: ProvisionerInput): AsyncGenerator<ProvisionProgress> {
    yield { phase: "done", status: await this.check(input) };
  }
}
