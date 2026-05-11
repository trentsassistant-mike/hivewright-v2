import { spawn } from "child_process";
import fs from "fs";
import { writeFile, unlink, mkdir, rm } from "fs/promises";
import path from "path";
import type { Adapter, AdapterProbeCredential, AdapterResult, ChunkCallback, ProbeResult, SessionContext } from "./types";
import { extractCleanResult } from "./openclaw-result-parser";
import { unhealthyProbeResult } from "./probe-classifier";
import { renderSessionPrompt } from "./context-renderer";

const OPENCLAW_BIN = ["/home/hivewright/.npm-global/bin/openclaw", "/usr/local/bin/openclaw", "openclaw"]
  .find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || "openclaw";

// Strip LLM-provider env keys before forwarding env to openclaw subprocesses.
// openclaw spawns claude/codex/etc CLIs that prefer env-var auth over their
// native OAuth. The owner's secrets file historically held an invalid
// ANTHROPIC_API_KEY that was 401-ing every dev-agent before the claude-code
// adapter started stripping it, and the same shape of bug applies to codex
// (OPENAI_API_KEY would override the now-active ChatGPT OAuth in ~/.codex/auth.json).
// Keep GITHUB_TOKEN — the github MCP server in openclaw.json explicitly requires it.
function buildOpenclawEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  env.PATH = `/home/hivewright/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`;
  return env as NodeJS.ProcessEnv;
}

const OPENCLAW_ENV = buildOpenclawEnv();

export interface OpenClawFiles {
  agentsMd: string;
  soulMd: string;
  toolsMd: string;
}

export function generateFiles(ctx: SessionContext): OpenClawFiles {
  // AGENTS.md: hive context + task + memory + skills + standing instructions.
  // SOUL.md/TOOLS.md carry identity for openclaw, so omit identity here.
  const agentsMd = renderSessionPrompt(ctx, {
    includeIdentity: false,
    workspace: ctx.projectWorkspace,
  });

  // SOUL.md: role identity + personality
  const soulParts: string[] = [];
  if (ctx.roleTemplate.roleMd) soulParts.push(ctx.roleTemplate.roleMd);
  if (ctx.roleTemplate.soulMd) soulParts.push(ctx.roleTemplate.soulMd);
  const soulMd = soulParts.join("\n\n");

  // TOOLS.md: capabilities
  const toolsMd = ctx.roleTemplate.toolsMd ?? "";

  return { agentsMd, soulMd, toolsMd };
}

function roleAgentId(ctx: SessionContext): string {
  if (ctx.roleTemplate.slug === "goal-supervisor" && ctx.task.goalId) {
    const hiveSlug = ctx.hiveSlug || "default";
    return `hw-gs-${hiveSlug}-${ctx.task.goalId.slice(0, 8)}`;
  }
  return `hw-${ctx.roleTemplate.slug}`;
}

export function buildCommand(ctx: SessionContext, prompt: string): string[] {
  const agentId = roleAgentId(ctx);
  return ["agent", "--agent", agentId, "--message", `/new ${prompt}`, "--json"];
}

export class OpenClawAdapter implements Adapter {
  supportsPersistence = true;

  async probe(modelId: string, credential: AdapterProbeCredential): Promise<ProbeResult> {
    void credential;
    return unhealthyProbeResult({
      failureClass: "gateway_retired",
      reason: {
        code: "gateway_retired",
        message: `OpenClaw gateway is retired for model '${modelId}'.`,
        retryable: false,
      },
      latencyMs: 0,
      costEstimateUsd: 0,
    });
  }

  translate(ctx: SessionContext): string {
    const { agentsMd, soulMd, toolsMd } = generateFiles(ctx);
    // generateFiles() already embeds hiveContext at the top of agentsMd, so
    // the assembled message preserves Identity (soulMd/toolsMd written to disk
    // as system files) → Hive Context → Task ordering when openclaw resolves
    // the full prompt.
    return [agentsMd, soulMd, toolsMd].filter(Boolean).join("\n\n");
  }

  async execute(ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult> {
    const workspace = ctx.projectWorkspace || process.cwd();
    const ctxDir = path.join(workspace, ".hivewright-ctx");
    const files: Record<string, string> = {};

    const { agentsMd, soulMd, toolsMd } = generateFiles(ctx);
    files["AGENTS.md"] = agentsMd;
    files["SOUL.md"] = soulMd;
    files["TOOLS.md"] = toolsMd;

    try {
      await mkdir(ctxDir, { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        // Write backup to ctx dir
        await writeFile(path.join(ctxDir, filename), content, "utf8");
        // Write to workspace root for openclaw to find
        await writeFile(path.join(workspace, filename), content, "utf8");
      }
    } catch (err) {
      return {
        success: false,
        output: "",
        failureReason: `Failed to write context files: ${(err as Error).message}`,
      };
    }

    const fullPrompt = this.translate(ctx);
    const args = buildCommand(ctx, fullPrompt);

    try {
      const result = await new Promise<AdapterResult>((resolve) => {
        const proc = spawn(OPENCLAW_BIN, args, {
          cwd: workspace,
          env: { ...OPENCLAW_ENV, ...ctx.credentials },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 600_000,
        });

        // Per-invocation TextDecoder pair — see commit 4ed135f for the streaming-
        // decoder rationale. Concurrent execute() calls must not share state.
        const decoder = new TextDecoder("utf-8");
        const stderrDecoder = new TextDecoder("utf-8");
        let stdout = "";
        let stderr = "";
        const chunkPromises: Promise<void>[] = [];

        // NOTE: we deliberately do NOT forward raw stdout to onChunk. The
        // openclaw CLI emits a single buffered JSON envelope at the end of
        // execution; forwarding it raw would expose telemetry to the user.
        // Instead we accumulate stdout, parse on close, and emit one clean
        // chunk via onChunk below.
        proc.stdout.on("data", (data: Buffer) => {
          stdout += decoder.decode(data, { stream: true });
        });

        proc.stderr.on("data", (data: Buffer) => {
          const text = stderrDecoder.decode(data, { stream: true });
          stderr += text;
          if (onChunk) {
            chunkPromises.push(onChunk({ text, type: "stderr" }).catch(() => {}));
          }
        });

        proc.on("close", async (code) => {
          // Flush any trailing partial UTF-8 codepoint from the streaming decoder.
          stdout += decoder.decode();

          if (code !== 0) {
            await Promise.allSettled(chunkPromises);
            resolve({
              success: false,
              output: stderr || stdout,
              failureReason: `Process exited with code ${code}: ${stderr}`,
            });
            return;
          }

          const clean = extractCleanResult(stdout);
          if (clean && onChunk) {
            chunkPromises.push(onChunk({ text: clean.text, type: "stdout" }).catch(() => {}));
          }
          await Promise.allSettled(chunkPromises);

          if (clean) {
            resolve({
              success: true,
              output: clean.text,
              tokensInput: clean.tokensInput,
              tokensOutput: clean.tokensOutput,
              modelUsed: clean.modelUsed,
            });
            return;
          }
          // Degraded fallback: parser returned null — emit raw stdout as best-effort.
          resolve({ success: true, output: stdout });
        });

        proc.on("error", async (err) => {
          await Promise.allSettled(chunkPromises);
          resolve({
            success: false,
            output: "",
            failureReason: `Spawn error: ${err.message}`,
          });
        });
      });

      return result;
    } finally {
      // Clean up context files in ALL paths (success, failure, error)
      for (const filename of Object.keys(files)) {
        try { await unlink(path.join(workspace, filename)); } catch { /* ignore */ }
      }
      try { await rm(ctxDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async startSession(ctx: SessionContext): Promise<{ sessionId: string }> {
    const workspace = ctx.projectWorkspace || process.cwd();
    const files = generateFiles(ctx);

    // Write context files
    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(workspace, filename), content, "utf-8");
    }

    const modelName = ctx.model.includes("/") ? ctx.model.split("/")[1] : ctx.model;

    // Start a persistent session via openclaw
    const proc = spawn(OPENCLAW_BIN, ["session", "start", "--model", modelName], {
      cwd: workspace,
      env: { ...OPENCLAW_ENV, ...ctx.credentials },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (data) => { stdout += data.toString(); });

    return new Promise((resolve, reject) => {
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(`Failed to start session: exit ${code}`));
        // Parse session ID from stdout
        const sessionId = stdout.trim() || `oc-${Date.now()}`;
        resolve({ sessionId });
      });
      proc.on("error", reject);
    });
  }

  async sendMessage(sessionId: string, message: string, ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult> {
    const workspace = ctx.projectWorkspace || process.cwd();

    return new Promise((resolve) => {
      const proc = spawn(OPENCLAW_BIN, ["session", "send", "--id", sessionId], {
        cwd: workspace,
        env: { ...OPENCLAW_ENV, ...ctx.credentials },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 600_000,
      });

      proc.stdin.write(message);
      proc.stdin.end();

      // Per-invocation TextDecoder pair — see commit 4ed135f for the streaming-
      // decoder rationale. Concurrent sendMessage() calls must not share state.
      const decoder = new TextDecoder("utf-8");
      const stderrDecoder = new TextDecoder("utf-8");
      let stdout = "";
      let stderr = "";
      const chunkPromises: Promise<void>[] = [];

      // Silent stdout accumulation — same rationale as execute(). Per-turn
      // openclaw output is also a buffered JSON envelope, not a stream.
      proc.stdout.on("data", (data: Buffer) => {
        stdout += decoder.decode(data, { stream: true });
      });
      proc.stderr.on("data", (data: Buffer) => {
        const text = stderrDecoder.decode(data, { stream: true });
        stderr += text;
        if (onChunk) {
          chunkPromises.push(onChunk({ text, type: "stderr" }).catch(() => {}));
        }
      });

      proc.on("close", async (code) => {
        // Flush any trailing partial UTF-8 codepoint from the streaming decoder.
        stdout += decoder.decode();

        if (code !== 0) {
          await Promise.allSettled(chunkPromises);
          resolve({ success: false, output: stderr || stdout, failureReason: `Session send failed: ${stderr}` });
          return;
        }

        const clean = extractCleanResult(stdout);
        if (clean && onChunk) {
          chunkPromises.push(onChunk({ text: clean.text, type: "stdout" }).catch(() => {}));
        }
        await Promise.allSettled(chunkPromises);

        if (clean) {
          resolve({
            success: true,
            output: clean.text,
            tokensInput: clean.tokensInput,
            tokensOutput: clean.tokensOutput,
            modelUsed: clean.modelUsed,
          });
          return;
        }
        // Degraded fallback: parser returned null. Return raw stdout as
        // AdapterResult.output so the task isn't blocked; we deliberately
        // do NOT push it to onChunk (avoids leaking a malformed envelope
        // into the live agent card).
        resolve({ success: true, output: stdout });
      });

      proc.on("error", async (err) => {
        await Promise.allSettled(chunkPromises);
        resolve({ success: false, output: "", failureReason: `Session error: ${err.message}` });
      });
    });
  }

  async terminateSession(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(OPENCLAW_BIN, ["session", "end", "--id", sessionId], {
        env: OPENCLAW_ENV,
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });
  }
}
