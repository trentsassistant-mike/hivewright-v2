import fs from "fs";
import os from "os";
import path from "path";

/**
 * Unified shape — superset of the two prior local copies in
 * src/provisioning/openclaw.ts (which carried richer per-entry metadata) and
 * src/openclaw/goal-supervisor-cleanup.ts (which was structural only).
 * Optional fields cover both consumers without forcing either to widen its
 * write path.
 */
export interface OpenClawConfig {
  agents?: {
    list?: Array<{
      id: string;
      name?: string;
      workspace?: string;
      agentDir?: string;
      model?: { primary?: string } | string;
      tools?: { allow?: string[]; deny?: string[] };
    } & Record<string, unknown>>;
    defaults?: { model?: { primary?: string } };
  };
}

export function openclawDir(): string {
  const cfgPath = process.env.OPENCLAW_CONFIG_PATH;
  if (cfgPath) return path.dirname(cfgPath);
  return path.join(os.homedir(), ".openclaw");
}

export function configPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH ?? path.join(openclawDir(), "openclaw.json");
}

export function agentDir(id: string): string {
  return path.join(openclawDir(), "agents", id);
}

export function workspaceDir(id: string): string {
  return path.join(openclawDir(), "workspaces", id);
}

export function readConfig(): { cfg: OpenClawConfig | null; error?: string } {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    return { cfg: JSON.parse(raw) as OpenClawConfig };
  } catch (e) {
    return { cfg: null, error: (e as Error).message };
  }
}

export function writeConfig(cfg: OpenClawConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
