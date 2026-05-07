import fs from "fs";
import type { Provisioner, ProvisionProgress, ProvisionStatus, ProvisionerInput } from "./types";
import { agentDir, readConfig, workspaceDir, writeConfig } from "../openclaw/config-io";

/**
 * goal-supervisor uses a per-goal agent id (`hw-gs-<hive>-<goalId[:8]>`),
 * created dynamically by the openclaw adapter on first spawn for each goal.
 * See src/adapters/openclaw.ts#roleAgentId. No static pre-registration is needed,
 * so the provisioner always reports satisfied for this role.
 */
function isGoalSupervisor(slug: string): boolean {
  return slug === "goal-supervisor";
}

export class OpenClawProvisioner implements Provisioner {
  async check({ slug }: ProvisionerInput): Promise<ProvisionStatus> {
    if (isGoalSupervisor(slug)) {
      return { satisfied: true, fixable: true };
    }
    const { cfg } = readConfig();
    if (!cfg) {
      return { satisfied: false, fixable: false, reason: "openclaw is not installed (no ~/.openclaw/openclaw.json)" };
    }
    const agentId = `hw-${slug}`;
    const entry = cfg.agents?.list?.find((a) => a.id === agentId);
    if (!entry) {
      return { satisfied: false, fixable: true, reason: `openclaw agent '${agentId}' is not registered` };
    }
    return { satisfied: true, fixable: true };
  }

  async *provision({ slug, recommendedModel }: ProvisionerInput): AsyncGenerator<ProvisionProgress> {
    if (isGoalSupervisor(slug)) {
      yield { phase: "done", status: { satisfied: true, fixable: true } };
      return;
    }
    yield { phase: "checking", message: "Reading openclaw config" };
    const { cfg } = readConfig();
    if (!cfg) {
      yield { phase: "done", status: { satisfied: false, fixable: false, reason: "openclaw is not installed" } };
      return;
    }

    const agentId = `hw-${slug}`;
    cfg.agents = cfg.agents ?? {};
    cfg.agents.list = cfg.agents.list ?? [];

    const existing = cfg.agents.list.find((a) => a.id === agentId);
    if (existing) {
      yield { phase: "done", status: { satisfied: true, fixable: true } };
      return;
    }

    yield { phase: "installing", message: `Registering agent '${agentId}' in openclaw.json` };
    const dir = agentDir(agentId);
    // NOTE: do not set `tools` here. OpenClaw expects { allow?: string[], deny?: string[] }
    // and rejects the entire config if it sees a flat array. Omitting the field lets the
    // agent inherit defaults; per-role deny lists can be added by hand if needed.
    cfg.agents.list.push({
      id: agentId,
      name: agentId,
      workspace: workspaceDir(agentId),
      agentDir: dir,
      model: { primary: recommendedModel },
    });

    fs.mkdirSync(dir, { recursive: true });

    writeConfig(cfg);
    yield { phase: "done", status: { satisfied: true, fixable: true } };
  }
}
