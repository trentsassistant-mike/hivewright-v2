import { jsonOk, jsonError } from "../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../_lib/auth";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

function runOpenClaw(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("openclaw", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
}

/** Read OpenClaw config directly from disk — instant, no CLI overhead */
function readOpenClawConfig(): Record<string, unknown> | null {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function GET(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  try {
    const url = new URL(request.url);
    const includeAgents = url.searchParams.get("agents") !== "false";

    // Read config directly from disk — instant
    const config = readOpenClawConfig();
    const models = config ? getNestedValue(config, "agents.defaults.models") as Record<string, { alias?: string }> | null : null;
    const defaultModel = config ? getNestedValue(config, "agents.defaults.model") as { primary: string; fallbacks: string[] } | null : null;

    // Read agents list from disk too (agents.list in openclaw.json)
    let agents: { id: string; model: string; fallbacks: string[]; name?: string }[] = [];
    if (includeAgents && config) {
      const agentsList = getNestedValue(config, "agents.list") as Array<{
        id: string; name?: string; model?: { primary: string; fallbacks?: string[] } | string;
      }> | null;
      if (Array.isArray(agentsList)) {
        agents = agentsList.map(a => {
          const modelObj = typeof a.model === "object" && a.model
            ? a.model
            : { primary: typeof a.model === "string" ? a.model : "unknown", fallbacks: [] };
          return {
            id: a.id,
            model: modelObj.primary,
            fallbacks: modelObj.fallbacks || [],
            name: a.name || a.id,
          };
        });
      }
    }

    const availableModels = models
      ? Object.entries(models).map(([id, meta]) => ({
          id,
          alias: meta?.alias || null,
        })).sort((a, b) => a.id.localeCompare(b.id))
      : [];

    return jsonOk({
      availableModels,
      defaultModel: defaultModel?.primary || null,
      fallbacks: defaultModel?.fallbacks || [],
      agents,
    });
  } catch {
    return jsonError("Failed to read OpenClaw config", 500);
  }
}

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json() as { action?: string; agentId?: string; model?: string; fallbacks?: string[] };
    const { action, agentId, model, fallbacks } = body;

    if (action === "set-default-model" && model) {
      const result = await runOpenClaw(["config", "set", "agents.defaults.model.primary", model]);
      if (result.code !== 0) return jsonError(`Failed: ${result.stderr}`, 500);
      return jsonOk({ updated: true });
    }

    if (action === "set-fallbacks" && Array.isArray(fallbacks)) {
      const result = await runOpenClaw(["config", "set", "agents.defaults.model.fallbacks", JSON.stringify(fallbacks)]);
      if (result.code !== 0) return jsonError(`Failed: ${result.stderr}`, 500);
      return jsonOk({ updated: true });
    }

    if (action === "set-agent-model" && agentId && model) {
      const result = await runOpenClaw(["config", "set", `agents.${agentId}.model`, model]);
      if (result.code !== 0) return jsonError(`Failed: ${result.stderr}`, 500);
      return jsonOk({ updated: true });
    }

    return jsonError("Invalid action", 400);
  } catch {
    return jsonError("Failed to update OpenClaw config", 500);
  }
}
