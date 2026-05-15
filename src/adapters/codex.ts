import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import type { Sql } from "postgres";
import type { Adapter, AdapterProbeCredential, AdapterResult, ChunkCallback, CodexEmptyOutputDiagnostic, ProbeResult, SessionContext } from "./types";
import { CodexJsonChunker } from "./codex-stream-parser";
import { resolveMcps, buildCodexMcpArgs } from "../tools/mcp-catalog";
import { healthyProbeResult, isCodexRolloutThreadNotFound, probeResultFromBoundaryError } from "./probe-classifier";
import { renderSessionPrompt } from "./context-renderer";
import { buildUsageDetails, normalizeBillableUsage } from "../usage/billable-usage";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
} from "../audit/agent-events";

/**
 * Direct codex CLI adapter — bypasses openclaw entirely.
 *
 * Roles routed through this adapter use the owner's ChatGPT (Plus/Pro/Team)
 * OAuth from `~/.codex/auth.json` instead of the per-token OPENAI_API_KEY,
 * so subscription-priced gpt-5.4 calls don't get billed twice.
 *
 * Mirrors ClaudeCodeAdapter so the dispatcher's task pipeline can swap one
 * for the other without code changes elsewhere.
 */
export class CodexAdapter implements Adapter {
  supportsPersistence = true;

  constructor(private readonly auditSql?: Sql) {}

  async probe(modelId: string, credential: AdapterProbeCredential): Promise<ProbeResult> {
    const startedAt = Date.now();
    const modelName = modelId.includes("/") ? modelId.split("/").at(-1)! : modelId;
    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-m",
      modelName,
    ];
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    delete baseEnv.OPENAI_API_KEY;
    delete baseEnv.OPENAI_BASE_URL;

    return new Promise((resolve) => {
      const proc = spawn("codex", args, {
        cwd: process.cwd(),
        env: { ...baseEnv, ...credential.secrets } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf-8"); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf-8"); });
      proc.stdin.write("Health probe. Reply with ok.");
      proc.stdin.end();

      proc.on("close", (code) => {
        const latencyMs = Date.now() - startedAt;
        if (isCodexRolloutThreadNotFound(stderr)) {
          resolve(probeResultFromBoundaryError({ stderr, stdout, latencyMs }));
          return;
        }
        if (code === 0) {
          resolve(healthyProbeResult({ latencyMs, costEstimateUsd: 0 }));
          return;
        }
        resolve(probeResultFromBoundaryError({
          code: code === 143 ? "timeout" : undefined,
          stderr,
          stdout,
          latencyMs,
        }));
      });

      proc.on("error", (err) => {
        resolve(probeResultFromBoundaryError({
          message: err.message,
          latencyMs: Date.now() - startedAt,
        }));
      });
    });
  }

  translate(ctx: SessionContext): string {
    return renderSessionPrompt(ctx, { workspace: resolveCodexEffectiveWorkspace(ctx) });
  }

  buildCommand(ctx: SessionContext): string[] {
    // codex model strings either come bare ("gpt-5.4") or qualified
    // ("openai-codex/gpt-5.4"). Strip the qualifier — codex only wants the
    // model name. Default `--cd <workspace>` lets us pin the working dir
    // even when the dispatcher's spawn cwd is something else.
    const modelName = ctx.model.includes("/") ? ctx.model.split("/")[1] : ctx.model;
    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-m", modelName,
    ];
    const effectiveWorkspace = resolveCodexEffectiveWorkspace(ctx);
    if (effectiveWorkspace) {
      args.push("-C", effectiveWorkspace);
    }

    // Per-role MCP scoping. Codex doesn't have a `--strict-mcp-config` style
    // flag — `-c mcp_servers.<name>.*` ADDS to the global config instead of
    // replacing it. Best-effort: roles with toolsConfig get their granted
    // MCPs explicitly added; if/when codex adds a strict-only flag we'll
    // wire it in here.
    if (ctx.toolsConfig?.mcps) {
      const mcpEntries = resolveMcps(ctx.toolsConfig.mcps);
      if (mcpEntries.length > 0) {
        args.push(...buildCodexMcpArgs(mcpEntries));
      }
    }

    return args;
  }

  async execute(ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult> {
    const prompt = this.translate(ctx);
    const args = this.buildCommand(ctx);
    const cwd = resolveCodexEffectiveWorkspace(ctx) || process.cwd();
    ensureCodexWorkspace(cwd);

    return this.runCodexProcess({ prompt, args, cwd, ctx, onChunk });
  }

  async sendMessage(
    sessionId: string,
    message: string,
    ctx: SessionContext,
    onChunk?: ChunkCallback,
  ): Promise<AdapterResult> {
    const args = [
      "exec",
      "resume",
      sessionId,
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-",
    ];
    const cwd = resolveCodexEffectiveWorkspace(ctx) || process.cwd();
    ensureCodexWorkspace(cwd);

    return this.runCodexProcess({
      prompt: message,
      args,
      cwd,
      ctx,
      onChunk,
      existingSessionId: sessionId,
    });
  }

  private async runCodexProcess(input: {
    prompt: string;
    args: string[];
    cwd: string;
    ctx: SessionContext;
    onChunk?: ChunkCallback;
    existingSessionId?: string | null;
  }): Promise<AdapterResult> {
    const { prompt, args, cwd, ctx, onChunk, existingSessionId = null } = input;
    // Strip OpenAI key env vars so codex falls back to its native ChatGPT
    // OAuth (~/.codex/auth.json with `auth_mode:"chatgpt"`). Otherwise an
    // OPENAI_API_KEY inherited from the dispatcher's secrets file forces
    // per-token API billing instead of using the owner's subscription.
    // Mirrors the same fix as the claude-code adapter.
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    delete baseEnv.OPENAI_API_KEY;
    delete baseEnv.OPENAI_BASE_URL;

    return new Promise((resolve) => {
      const proc = spawn("codex", args, {
        cwd,
        env: { ...baseEnv, ...ctx.credentials } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // 4-hour wall-clock cap — matches claude-code adapter so executor
        // tasks running on either backend get the same bounded autonomy.
        // Heartbeat watchdog (5 min) is the primary stuck-process gate.
        timeout: 14_400_000,
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      const chunker = new CodexJsonChunker();
      let rawStdout = "";
      let stderr = "";
      const chunkPromises: Promise<void>[] = [];

      const decoder = new TextDecoder("utf-8");
      proc.stdout.on("data", (data: Buffer) => {
        const text = decoder.decode(data, { stream: true });
        rawStdout += text;
        const { texts } = chunker.feed(text);
        if (onChunk && texts.length > 0) {
          for (const t of texts) {
            chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
          }
        }
      });

      const stderrDecoder = new TextDecoder("utf-8");
      proc.stderr.on("data", (data: Buffer) => {
        const text = stderrDecoder.decode(data, { stream: true });
        stderr += text;
        if (onChunk) {
          chunkPromises.push(onChunk({ text, type: "stderr" }).catch(() => {}));
        }
      });

      proc.on("close", async (code) => {
        const finalText = decoder.decode();
        if (finalText) {
          rawStdout += finalText;
          const { texts } = chunker.feed(finalText);
          if (onChunk && texts.length > 0) {
            for (const t of texts) {
              chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
            }
          }
        }
        const tail = chunker.flush();
        if (onChunk && tail.texts.length > 0) {
          for (const t of tail.texts) {
            chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
          }
        }
        const finalStderr = stderrDecoder.decode();
        if (finalStderr) {
          stderr += finalStderr;
          if (onChunk) {
            chunkPromises.push(onChunk({ text: finalStderr, type: "stderr" }).catch(() => {}));
          }
        }
        await Promise.allSettled(chunkPromises);

        const result = tail.result;
        const sessionId = tail.threadId ?? existingSessionId ?? null;
        const allTexts = collectCodexAgentTexts(rawStdout);
        const finalOutput = collectCodexFinalAgentText(rawStdout) || allTexts;
        const rolloutRegistrationFailed = isCodexRolloutRegistrationFailure(stderr || rawStdout);
        const rolloutRegistrationStderrSignaturePresent = isCodexRolloutRegistrationFailure(stderr);
        const rolloutWarning = rolloutRegistrationFailed
          ? "Codex rollout registration failed after agent output was captured; HiveWright persisted stdout directly and QA should verify the recorded tail."
          : null;

        if (code !== 0) {
          if (rolloutRegistrationFailed && allTexts) {
            const usageDetails = result
              ? buildUsageDetails(normalizeBillableUsage({
                totalInputTokens: result.tokensInput,
                freshInputTokens: result.freshInputTokens,
                cachedInputTokens: result.cachedInputTokens,
                cachedInputTokensKnown: result.cachedInputTokensKnown,
                tokensOutput: result.tokensOutput,
              }))
              : undefined;
            resolve({
              success: true,
              output: allTexts,
              sessionId,
              failureReason:
                "Codex rollout registration failed after agent output was captured; salvaged output for idempotent dispatcher finalization.",
              runtimeWarnings: rolloutWarning ? [rolloutWarning] : undefined,
              tokensInput: result?.tokensInput,
              freshInputTokens: result?.freshInputTokens,
              cachedInputTokens: result?.cachedInputTokens,
              cachedInputTokensKnown: result?.cachedInputTokensKnown,
              tokensOutput: result?.tokensOutput,
              modelUsed: result?.modelUsed,
              estimatedBillableCostCents: 0,
              usageDetails,
            });
            return;
          }
          let emptyOutputDiagnostic: CodexEmptyOutputDiagnostic | undefined;
          if (!allTexts) {
            emptyOutputDiagnostic = buildCodexEmptyOutputDiagnostic({
              rawStdout,
              stderr,
              exitCode: code,
              effectiveAdapter: "codex",
              adapterOverride: ctx.task.adapterOverride ?? null,
              modelSlug: ctx.model,
              modelProviderMismatchDetected: detectCodexModelProviderMismatch("codex", ctx.model),
              cwd,
              taskWorkspace: ctx.projectWorkspace,
              rolloutSignaturePresent: rolloutRegistrationStderrSignaturePresent,
            });
            await this.recordEmptyOutputFailureDiagnostic(ctx, {
              diagnostic: emptyOutputDiagnostic,
            });
          }
          if (code === 143 && (!stderr || stderr.trim() === "")) {
            resolve({
              success: false,
              output: stderr || rawStdout,
              sessionId,
              failureReason:
                "Execution slice exceeded adapter timeout (30 minutes). Task likely needs decomposition into smaller tasks or checkpointed implementation.",
              failureKind: "execution_slice_exceeded",
              runtimeDiagnostics: emptyOutputDiagnostic
                ? { codexEmptyOutput: emptyOutputDiagnostic }
                : undefined,
            });
            return;
          }
          if (result?.isError && result.errorMessage) {
            resolve({
              success: false,
              output: result.errorMessage,
              sessionId,
              failureReason: `Codex exited code ${code}: ${result.errorMessage.slice(0, 500)}`,
              failureKind: "unknown",
              runtimeDiagnostics: emptyOutputDiagnostic
                ? { codexEmptyOutput: emptyOutputDiagnostic }
                : undefined,
            });
            return;
          }
          resolve({
            success: false,
            output: stderr || rawStdout,
            sessionId,
            failureReason: `Process exited with code ${code}: ${stderr.trim() || "(no error detail)"}`,
            failureKind: "unknown",
            runtimeDiagnostics: emptyOutputDiagnostic
              ? { codexEmptyOutput: emptyOutputDiagnostic }
              : undefined,
          });
          return;
        }

        if (result) {
          const usageDetails = buildUsageDetails(normalizeBillableUsage({
            totalInputTokens: result.tokensInput,
            freshInputTokens: result.freshInputTokens,
            cachedInputTokens: result.cachedInputTokens,
            cachedInputTokensKnown: result.cachedInputTokensKnown,
            tokensOutput: result.tokensOutput,
          }));
          resolve({
            success: !result.isError,
            output: finalOutput || rawStdout,
            sessionId,
            runtimeWarnings: rolloutWarning ? [rolloutWarning] : undefined,
            tokensInput: result.tokensInput,
            freshInputTokens: result.freshInputTokens,
            cachedInputTokens: result.cachedInputTokens,
            cachedInputTokensKnown: result.cachedInputTokensKnown,
            tokensOutput: result.tokensOutput,
            modelUsed: result.modelUsed,
            estimatedBillableCostCents: 0,
            usageDetails,
          });
          return;
        }

        // No turn.completed envelope captured — degraded fallback.
        resolve({
          success: true,
          output: finalOutput || rawStdout,
          sessionId,
          runtimeWarnings: rolloutWarning ? [rolloutWarning] : undefined,
        });
      });

      proc.on("error", async (err) => {
        await Promise.allSettled(chunkPromises);
        resolve({
          success: false,
          output: "",
          sessionId: existingSessionId ?? null,
          failureReason: `Spawn error: ${err.message}`,
          failureKind: "spawn_error",
        });
      });
    });
  }

  private async recordEmptyOutputFailureDiagnostic(
    ctx: SessionContext,
    input: {
      diagnostic: CodexEmptyOutputDiagnostic;
    },
  ): Promise<void> {
    if (!this.auditSql) return;

    await recordAgentAuditEventBestEffort(this.auditSql, {
      actor: { type: "system", id: "codex-adapter", label: "Codex Adapter" },
      eventType: AGENT_AUDIT_EVENTS.codexEmptyOutputFailure,
      hiveId: ctx.task.hiveId,
      goalId: ctx.task.goalId,
      taskId: ctx.task.id,
      agentId: `task:${ctx.task.id}`,
      targetType: "adapter_run",
      targetId: ctx.task.id,
      outcome: "error",
      metadata: {
        codexEvents: input.diagnostic.terminalEvents,
        exitCode: input.diagnostic.exitCode,
        effectiveAdapter: input.diagnostic.effectiveAdapter,
        adapterOverride: input.diagnostic.adapterOverride,
        modelSlug: input.diagnostic.modelSlug,
        modelProviderMismatchDetected: input.diagnostic.modelProviderMismatchDetected,
        cwd: input.diagnostic.cwd,
        rolloutRegistrationSignaturePresent: input.diagnostic.rolloutSignaturePresent,
      },
    });
  }

}

type SanitizedCodexFailureEvent = {
  type: "turn.failed" | "error";
  ids: Record<string, string>;
  error: {
    code?: string;
    message?: string;
    type?: string;
    id?: string;
  };
};

const CODEX_EMPTY_OUTPUT_DIAGNOSTIC_BYTE_CAP = 8192;
const CODEX_EMPTY_OUTPUT_STDERR_TAIL_BYTE_CAP = 4096;
const CODEX_EMPTY_OUTPUT_TRUNCATION_MARKER =
  "[...TRUNCATED_CODEX_EMPTY_OUTPUT_DIAGNOSTIC_8192_BYTES]" as const;

/**
 * When dispatcher-owned per-task git isolation is active, codex operates inside
 * that worktree. Git-backed project tasks without a provisioned worktree still
 * use the explicit project workspace. Non-git hive/business tasks get a clean
 * dispatcher-owned task workspace outside the business artifact tree so stale
 * AGENTS.md files and historical reports cannot become live instructions.
 */
function resolveCodexEffectiveWorkspace(ctx: SessionContext): string | null {
  if (
    ctx.workspaceIsolation?.status === "active" &&
    ctx.workspaceIsolation.worktreePath
  ) {
    return ctx.workspaceIsolation.worktreePath;
  }
  if (ctx.gitBackedProject === true) {
    return ctx.projectWorkspace;
  }
  return resolveCleanNonGitTaskWorkspace(ctx);
}

function resolveCleanNonGitTaskWorkspace(ctx: SessionContext): string {
  const configuredRoot = process.env.HIVEWRIGHT_TASK_WORKSPACE_ROOT?.trim();
  const root = configuredRoot && configuredRoot.length > 0
    ? configuredRoot
    : path.join(os.homedir(), ".hivewright", "task-workspaces");
  const safeTaskId = ctx.task.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(root, safeTaskId);
}

function ensureCodexWorkspace(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
}

/**
 * Walk the JSONL stdout one more time to concatenate all `agent_message`
 * texts in order. We need this because codex emits each agent message as
 * its own item.completed event, with no terminal "result" string field —
 * unlike claude's stream-json which has a final consolidated result.
 */
export function collectCodexAgentTexts(rawStdout: string): string {
  const out: string[] = [];
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const ev = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: string } };
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
        out.push(ev.item.text);
      }
    } catch { /* ignore */ }
  }
  return out.join("\n\n").trim();
}

export function collectCodexFinalAgentText(rawStdout: string): string {
  const messages: string[] = [];
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const ev = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: string } };
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
        const text = ev.item.text.trim();
        if (text.length > 0) messages.push(text);
      }
    } catch { /* ignore */ }
  }
  return messages.at(-1) ?? "";
}

export function isCodexRolloutRegistrationFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("failed to record rollout items") &&
    normalized.includes("thread") &&
    normalized.includes("not found")
  );
}

export function collectSanitizedCodexFailureEvents(
  rawStdout: string,
  stderr: string,
  taskWorkspace: string | null = null,
): SanitizedCodexFailureEvent[] {
  const events: SanitizedCodexFailureEvent[] = [];
  for (const line of `${rawStdout}\n${stderr}`.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const event = parsed as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : null;
    if (type !== "turn.failed" && type !== "error") continue;

    events.push({
      type,
      ids: collectCodexInternalIds(event, taskWorkspace),
      error: sanitizeCodexError(event.error, taskWorkspace),
    });
  }
  return events;
}

export function buildCodexEmptyOutputDiagnostic(input: {
  rawStdout: string;
  stderr: string;
  exitCode: number | null;
  effectiveAdapter?: string | null;
  adapterOverride?: string | null;
  modelSlug: string;
  modelProviderMismatchDetected?: boolean;
  cwd: string;
  taskWorkspace: string | null;
  rolloutSignaturePresent: boolean;
}): CodexEmptyOutputDiagnostic {
  const taskWorkspace = input.taskWorkspace;
  const base: CodexEmptyOutputDiagnostic = {
    kind: "codex_empty_output",
    schemaVersion: 1,
    codexEmptyOutput: true,
    exitCode: input.exitCode,
    effectiveAdapter: input.effectiveAdapter
      ? sanitizeDiagnosticString(input.effectiveAdapter, taskWorkspace)
      : null,
    adapterOverride: input.adapterOverride
      ? sanitizeDiagnosticString(input.adapterOverride, taskWorkspace)
      : null,
    modelSlug: sanitizeDiagnosticString(input.modelSlug, taskWorkspace),
    modelProviderMismatchDetected: input.modelProviderMismatchDetected ?? false,
    cwd: sanitizeDiagnosticCwd(input.cwd, taskWorkspace),
    taskWorkspace: taskWorkspace ? sanitizeDiagnosticString(taskWorkspace, taskWorkspace) : null,
    rolloutSignaturePresent: input.rolloutSignaturePresent,
    stderrTail: takeLastBytes(
      sanitizeDiagnosticString(input.stderr, taskWorkspace),
      CODEX_EMPTY_OUTPUT_STDERR_TAIL_BYTE_CAP,
    ),
    terminalEvents: collectSanitizedCodexFailureEvents(input.rawStdout, input.stderr, taskWorkspace),
    truncated: false,
  };

  return enforceCodexDiagnosticByteCap(base);
}

export function detectCodexModelProviderMismatch(
  effectiveAdapter: string | null | undefined,
  modelSlug: string | null | undefined,
): boolean {
  if (effectiveAdapter !== "codex" || !modelSlug) return false;
  const slashIndex = modelSlug.indexOf("/");
  if (slashIndex < 0) return false;
  const provider = modelSlug.slice(0, slashIndex).toLowerCase();
  return provider !== "openai" && provider !== "openai-codex";
}

function enforceCodexDiagnosticByteCap(
  diagnostic: CodexEmptyOutputDiagnostic,
): CodexEmptyOutputDiagnostic {
  if (Buffer.byteLength(JSON.stringify(diagnostic), "utf8") <= CODEX_EMPTY_OUTPUT_DIAGNOSTIC_BYTE_CAP) {
    return diagnostic;
  }

  const capped: CodexEmptyOutputDiagnostic = {
    ...diagnostic,
    truncated: true,
    truncationMarker: CODEX_EMPTY_OUTPUT_TRUNCATION_MARKER,
    stderrTail: takeLastBytes(diagnostic.stderrTail, CODEX_EMPTY_OUTPUT_STDERR_TAIL_BYTE_CAP),
    terminalEvents: [...diagnostic.terminalEvents],
  };

  while (
    capped.terminalEvents.length > 0 &&
    Buffer.byteLength(JSON.stringify(capped), "utf8") > CODEX_EMPTY_OUTPUT_DIAGNOSTIC_BYTE_CAP
  ) {
    capped.terminalEvents.shift();
  }

  while (
    capped.stderrTail.length > 0 &&
    Buffer.byteLength(JSON.stringify(capped), "utf8") > CODEX_EMPTY_OUTPUT_DIAGNOSTIC_BYTE_CAP
  ) {
    capped.stderrTail = takeLastBytes(capped.stderrTail, Math.max(0, Buffer.byteLength(capped.stderrTail, "utf8") - 512));
  }

  return capped;
}

function collectCodexInternalIds(event: Record<string, unknown>, taskWorkspace: string | null): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value !== "string") continue;
    const normalized = key.toLowerCase();
    if (normalized === "id" || normalized.endsWith("_id")) {
      ids[key] = sanitizeDiagnosticString(value, taskWorkspace);
    }
  }
  return ids;
}

function sanitizeCodexError(error: unknown, taskWorkspace: string | null): SanitizedCodexFailureEvent["error"] {
  if (typeof error === "string") {
    return { message: sanitizeDiagnosticString(error, taskWorkspace) };
  }
  if (!error || typeof error !== "object") return {};

  const source = error as Record<string, unknown>;
  const sanitized: SanitizedCodexFailureEvent["error"] = {};
  for (const key of ["code", "message", "type", "id"] as const) {
    const value = source[key];
    if (typeof value === "string") {
      sanitized[key] = sanitizeDiagnosticString(value, taskWorkspace);
    } else if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = String(value);
    }
  }
  if (sanitized.message) {
    sanitized.message = takeFirstChars(sanitized.message, 1000);
  }
  return sanitized;
}

function sanitizeDiagnosticString(value: string, taskWorkspace: string | null = null): string {
  let sanitized = value
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_.-]*)=([^\s"'`]+)/gi, "$1=[REDACTED]")
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]")
    .replace(/\b(cookie|authorization)=([^\s"'`]+)/gi, "$1=[REDACTED]");

  sanitized = redactOutsideWorkspaceHomePaths(sanitized, taskWorkspace);
  return sanitized;
}

function sanitizeDiagnosticCwd(cwd: string, taskWorkspace: string | null): string {
  if (!taskWorkspace) return redactOutsideWorkspaceHomePaths(cwd, taskWorkspace);
  const relative = path.relative(taskWorkspace, cwd);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return cwd;
  }
  return "[REDACTED_OUTSIDE_WORKSPACE]";
}

function redactOutsideWorkspaceHomePaths(value: string, taskWorkspace: string | null): string {
  return value.replace(/\/home\/[^/\s"'`]+\/[^\s"'`]*/g, (match) => {
    if (taskWorkspace) {
      const relative = path.relative(taskWorkspace, match);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return match;
      }
    }
    return "[REDACTED_HOME_PATH]";
  });
}

function takeFirstChars(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function takeLastBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
}
