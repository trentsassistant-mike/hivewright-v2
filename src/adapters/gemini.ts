import { spawn } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { Adapter, AdapterProbeCredential, AdapterResult, ChunkCallback, ProbeResult, SessionContext } from "./types";
import { resolveMcps, buildGeminiMcpSettings } from "../tools/mcp-catalog";
import { healthyProbeResult, probeResultFromBoundaryError } from "./probe-classifier";
import { renderSessionPrompt } from "./context-renderer";

interface GeminiStreamResult {
  isError: boolean;
  errorMessage?: string;
  tokensInput?: number;
  tokensOutput?: number;
  modelUsed?: string;
}

const GEMINI_PROBE_SOFT_KILL_MS = 60_000;
const GEMINI_PROBE_HARD_KILL_MS = 75_000;

type GeminiSettings = {
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  [key: string]: unknown;
};

export function normalizeGeminiModelId(model: string): string {
  if (model.startsWith("google/")) return model.slice("google/".length);
  if (model.startsWith("gemini/")) return model.slice("gemini/".length);
  return model;
}

export function parseGeminiStreamJson(rawStdout: string): { text: string; result: GeminiStreamResult | null } {
  const textParts: string[] = [];
  let result: GeminiStreamResult | null = null;

  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        role?: string;
        content?: string;
        status?: string;
        error?: { message?: string };
        model?: string;
        stats?: {
          input_tokens?: number;
          output_tokens?: number;
          models?: Record<string, { input_tokens?: number; output_tokens?: number }>;
        };
      };

      if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
        textParts.push(event.content);
      }

      if (event.type === "init" && typeof event.model === "string") {
        result = { ...(result ?? { isError: false }), modelUsed: `google/${normalizeGeminiModelId(event.model)}` };
      }

      if (event.type === "result") {
        const modelUsed: string | undefined = chooseGeminiStatsModel(event.stats?.models) ?? result?.modelUsed;
        result = {
          isError: event.status === "error",
          errorMessage: event.error?.message,
          tokensInput: event.stats?.input_tokens,
          tokensOutput: event.stats?.output_tokens,
          modelUsed,
        };
      }
    } catch {
      // Ignore non-JSON diagnostic lines. The CLI can still emit warnings.
    }
  }

  return { text: textParts.join("").trim(), result };
}

export class GeminiAdapter implements Adapter {
  supportsPersistence = false;

  async probe(modelId: string, credential: AdapterProbeCredential): Promise<ProbeResult> {
    const startedAt = Date.now();
    const modelName = normalizeGeminiModelId(modelId);
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...credential.secrets,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };

    return new Promise((resolve) => {
      const proc = spawn("gemini", [
        "--model", modelName,
        "--prompt", "",
        "--output-format", "stream-json",
        "--approval-mode", "yolo",
        "--skip-trust",
      ], {
        cwd: process.cwd(),
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let rawStdout = "";
      let stderr = "";
      let resolved = false;
      const settle = (result: ProbeResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(softKillTimer);
        clearTimeout(hardKillTimer);
        resolve(result);
      };

      // The gemini CLI traps SIGTERM during its internal 429-retry loop, so a
      // bare spawn `timeout` lets the process run for ~5 minutes past the cap.
      // Escalate to SIGKILL after a short grace.
      const softKillTimer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
      }, GEMINI_PROBE_SOFT_KILL_MS);
      const hardKillTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already exited */ }
        settle(probeResultFromBoundaryError({
          code: "timeout",
          stderr,
          stdout: rawStdout,
          latencyMs: Date.now() - startedAt,
        }));
      }, GEMINI_PROBE_HARD_KILL_MS);

      proc.stdout.on("data", (data: Buffer) => { rawStdout += data.toString("utf-8"); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf-8"); });
      proc.stdin.write("Health probe. Reply with ok.");
      proc.stdin.end();

      proc.on("close", (code) => {
        const latencyMs = Date.now() - startedAt;
        const parsed = parseGeminiStreamJson(rawStdout);
        if (code === 0 && !parsed.result?.isError) {
          settle(healthyProbeResult({ latencyMs, costEstimateUsd: 0.00001 }));
          return;
        }
        settle(probeResultFromBoundaryError({
          code: code === 143 ? "timeout" : undefined,
          message: parsed.result?.errorMessage,
          stderr,
          stdout: rawStdout,
          latencyMs,
        }));
      });

      proc.on("error", (err) => {
        settle(probeResultFromBoundaryError({
          message: err.message,
          latencyMs: Date.now() - startedAt,
        }));
      });
    });
  }

  translate(ctx: SessionContext): string {
    return renderSessionPrompt(ctx);
  }

  buildCommand(ctx: SessionContext): string[] {
    return [
      "--model", normalizeGeminiModelId(ctx.model),
      "--prompt", "",
      "--output-format", "stream-json",
      "--approval-mode", "yolo",
      "--skip-trust",
    ];
  }

  async execute(ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult> {
    const prompt = this.translate(ctx);
    const args = this.buildCommand(ctx);
    const mcpHome = await prepareGeminiHome(ctx);

    const baseEnv: Record<string, string | undefined> = { ...process.env };
    const env: Record<string, string | undefined> = {
      ...baseEnv,
      ...ctx.credentials,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };
    if (mcpHome.geminiCliHome) {
      env.GEMINI_CLI_HOME = mcpHome.geminiCliHome;
    }

    return new Promise((resolve) => {
      const proc = spawn("gemini", args, {
        cwd: ctx.projectWorkspace || process.cwd(),
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 14_400_000,
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      let rawStdout = "";
      let stderr = "";
      const chunkPromises: Promise<void>[] = [];
      const decoder = new TextDecoder("utf-8");
      const stderrDecoder = new TextDecoder("utf-8");

      proc.stdout.on("data", (data: Buffer) => {
        const text = decoder.decode(data, { stream: true });
        rawStdout += text;
        for (const t of assistantTextsFromGeminiChunk(text)) {
          if (onChunk) chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = stderrDecoder.decode(data, { stream: true });
        stderr += text;
        if (onChunk) {
          chunkPromises.push(onChunk({ text, type: "stderr" }).catch(() => {}));
        }
      });

      proc.on("close", async (code) => {
        const finalText = decoder.decode();
        if (finalText) rawStdout += finalText;
        await Promise.allSettled(chunkPromises);
        await mcpHome.cleanup();

        const parsed = parseGeminiStreamJson(rawStdout);
        const result = parsed.result;

        if (code !== 0) {
          if (code === 143 && (!stderr || stderr.trim() === "")) {
            resolve({
              success: false,
              output: stderr || rawStdout,
              failureReason:
                "Execution slice exceeded adapter timeout (30 minutes). Task likely needs decomposition into smaller tasks or checkpointed implementation.",
              failureKind: "execution_slice_exceeded",
            });
            return;
          }
          if (result?.isError && result.errorMessage) {
            resolve({
              success: false,
              output: result.errorMessage,
              failureReason: `Gemini exited code ${code}: ${result.errorMessage.slice(0, 500)}`,
              failureKind: "unknown",
              tokensInput: result.tokensInput,
              tokensOutput: result.tokensOutput,
              modelUsed: result.modelUsed,
            });
            return;
          }
          resolve({
            success: false,
            output: stderr || rawStdout,
            failureReason: `Process exited with code ${code}: ${stderr.trim() || "(no error detail)"}`,
            failureKind: "unknown",
          });
          return;
        }

        if (result) {
          resolve({
            success: !result.isError,
            output: parsed.text || rawStdout,
            failureReason: result.isError ? result.errorMessage : undefined,
            tokensInput: result.tokensInput,
            tokensOutput: result.tokensOutput,
            modelUsed: result.modelUsed ?? `google/${normalizeGeminiModelId(ctx.model)}`,
          });
          return;
        }

        resolve({ success: true, output: parsed.text || rawStdout });
      });

      proc.on("error", async (err) => {
        await Promise.allSettled(chunkPromises);
        await mcpHome.cleanup();
        resolve({
          success: false,
          output: "",
          failureReason: `Spawn error: ${err.message}`,
          failureKind: "spawn_error",
        });
      });
    });
  }
}

function assistantTextsFromGeminiChunk(text: string): string[] {
  const parsed = parseGeminiStreamJson(text);
  return parsed.text ? [parsed.text] : [];
}

function chooseGeminiStatsModel(models: Record<string, { input_tokens?: number; output_tokens?: number }> | undefined): string | undefined {
  if (!models) return undefined;
  const entries = Object.entries(models);
  const top = entries.sort(
    ([, a], [, b]) => ((b.input_tokens ?? 0) + (b.output_tokens ?? 0)) - ((a.input_tokens ?? 0) + (a.output_tokens ?? 0)),
  )[0];
  const name = top?.[0];
  return name ? `google/${normalizeGeminiModelId(name)}` : undefined;
}

async function prepareGeminiHome(ctx: SessionContext): Promise<{ geminiCliHome?: string; cleanup: () => Promise<void> }> {
  const entries = resolveMcps(ctx.toolsConfig?.mcps);
  if (!ctx.toolsConfig || (ctx.toolsConfig.mcps === undefined && entries.length === 0)) {
    return { cleanup: async () => {} };
  }

  const settings = buildGeminiMcpSettings(entries);
  const stableHome = ctx.credentials.GEMINI_CLI_HOME || process.env.GEMINI_CLI_HOME;
  if (stableHome) {
    const settingsPath = path.join(stableHome, ".gemini", "settings.json");
    let previous: string | null = null;
    try {
      previous = await readFile(settingsPath, "utf-8");
    } catch {
      previous = null;
    }
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const merged = mergeGeminiSettings(previous, settings);
    await writeFile(settingsPath, JSON.stringify(merged, null, 2), "utf-8");
    return {
      cleanup: async () => {
        if (previous === null) {
          await rm(settingsPath, { force: true });
        } else {
          await writeFile(settingsPath, previous, "utf-8");
        }
      },
    };
  }

  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "hivewright-gemini-"));
  const settingsPath = path.join(tmpHome, ".gemini", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  return {
    geminiCliHome: tmpHome,
    cleanup: async () => {
      await rm(tmpHome, { recursive: true, force: true });
    },
  };
}

function mergeGeminiSettings(previous: string | null, next: GeminiSettings): GeminiSettings {
  if (!previous) return next;
  try {
    const parsed = JSON.parse(previous) as GeminiSettings;
    return {
      ...parsed,
      mcpServers: next.mcpServers ?? {},
    };
  } catch {
    return next;
  }
}
