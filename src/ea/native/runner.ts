import { spawn } from "child_process";
import { CodexJsonChunker } from "../../adapters/codex-stream-parser";
import { cleanOwnerVisibleEaReply } from "./output-hygiene";

/**
 * Thin wrapper around the `codex` CLI for EA conversational turns.
 * Not a dispatcher adapter — we don't go through the task-claim flow
 * because the EA is free-form chat, not task execution. Same underlying
 * runtime as the Codex task adapter, just without the task-shaped
 * SessionContext envelope.
 */

export interface RunEaResult {
  success: boolean;
  text: string;
  error?: string;
}

export interface RunEaOptions {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  onChunk?: (delta: string) => void;
  attachmentPaths?: string[];
  /**
   * When aborted, the spawned `codex` subprocess is sent SIGTERM. Used
   * by `runEaStream` to cancel the underlying run when a consumer breaks
   * out of the `for await` loop early (e.g. voice-call hangup mid-reply)
   * so we don't keep burning tokens on output nobody will read.
   */
  signal?: AbortSignal;
}

function appendOwnerVisibleText(
  text: string,
  emit: (text: string) => void,
): void {
  const cleaned = cleanOwnerVisibleEaReply(text);
  if (cleaned.removedInternalProcessText.length > 0) {
    console.info("[ea-native] suppressed internal process text from owner-visible reply", {
      removedLines: cleaned.removedInternalProcessText,
    });
  }
  if (cleaned.text.length > 0) emit(cleaned.text);
}

export async function runEa(
  prompt: string,
  options: RunEaOptions = {},
): Promise<RunEaResult> {
  const model = normalizeEaModel(options.model);
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    // No --max-turns cap. Owner subscriptions bound cost externally;
    // arbitrary turn caps were forcing the EA into premature stop on
    // legitimately long investigations. Wall-clock cap below covers
    // genuine runaway protection.
  ];
  if (model) {
    const modelName = model.includes("/") ? model.split("/")[1] : model;
    args.push("-m", modelName);
  }
  const cwd = options.cwd ?? process.cwd();
  args.push("-C", cwd);

  // Mirror the Codex task adapter's env hygiene — strip lingering API-key
  // env vars so the CLI falls back to the owner's ChatGPT OAuth.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;

  return new Promise((resolve) => {
    const proc = spawn("codex", args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // 4-hour wall-clock cap — matches the executor adapters so EA
      // turns can take as long as they legitimately need. Typical EA
      // turns finish in seconds; this only matters for deep
      // investigations.
      timeout: options.timeoutMs ?? 14_400_000,
    });

    // Wire up AbortSignal -> SIGTERM so `runEaStream` (and any other
    // caller) can cancel the subprocess if they no longer want the
    // output. If already aborted, fire once synchronously; otherwise
    // register + deregister on close to avoid leaking listeners.
    if (options.signal) {
      if (options.signal.aborted) {
        try { proc.kill("SIGTERM"); } catch {}
      } else {
        const onAbort = () => { try { proc.kill("SIGTERM"); } catch {} };
        options.signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => options.signal?.removeEventListener("abort", onAbort));
      }
    }

    proc.stdin.write(withAttachmentReferences(prompt, options.attachmentPaths ?? []));
    proc.stdin.end();

    const chunker = new CodexJsonChunker();
    let assembled = "";
    let stderr = "";
    const decoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");

    proc.stdout.on("data", (data: Buffer) => {
      const text = decoder.decode(data, { stream: true });
      const { texts } = chunker.feed(text);
      for (const t of texts) {
        appendOwnerVisibleText(t, (cleaned) => {
          assembled += cleaned;
          options.onChunk?.(cleaned);
        });
      }
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += stderrDecoder.decode(data, { stream: true });
    });

    proc.on("close", (code) => {
      // Drain any straggling UTF-8 bytes + unterminated chunker line.
      const tail = decoder.decode();
      if (tail) {
        const { texts } = chunker.feed(tail);
        for (const t of texts) {
          appendOwnerVisibleText(t, (cleaned) => {
            assembled += cleaned;
            options.onChunk?.(cleaned);
          });
        }
      }
      const flushed = chunker.flush();
      for (const t of flushed.texts) {
        appendOwnerVisibleText(t, (cleaned) => {
          assembled += cleaned;
          options.onChunk?.(cleaned);
        });
      }

      if (code !== 0) {
        const result = flushed.result;
        resolve({
          success: false,
          text: assembled,
          error: result?.isError && result.errorMessage
            ? `codex exited ${code}: ${result.errorMessage}`
            : `codex exited ${code}: ${stderr.slice(0, 500)}`,
        });
        return;
      }
      resolve({ success: true, text: assembled });
    });

    proc.on("error", (err) => {
      resolve({ success: false, text: assembled, error: err.message });
    });
  });
}

export function normalizeEaModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  return trimmed || undefined;
}

function withAttachmentReferences(prompt: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) return prompt;
  const refs = attachmentPaths.map((attachmentPath) => `@${attachmentPath}`).join("\n");
  return `${prompt}\n\n## Attached file references\n${refs}`;
}

/**
 * Streaming variant of `runEa`. Yields text deltas as they're emitted by
 * the underlying Codex CLI so voice callers can pipe chunks straight
 * into TTS without waiting for the whole turn to finish. Built on top of
 * `runEa`'s `onChunk` callback via a small async queue — chunks are
 * pushed in as they arrive and pulled out in order by the generator.
 *
 * If the underlying run fails (non-zero exit or spawn error), the error
 * is thrown from the generator once the run settles. Chunks already
 * flushed before the failure are still yielded first — callers can
 * choose whether to speak them or discard.
 */
export async function* runEaStream(
  prompt: string,
  options: RunEaOptions = {},
): AsyncGenerator<string> {
  // Local controller so we can cancel the subprocess in our `finally`
  // — fires on normal completion, thrown errors, AND early `break` /
  // `.return()` by the consumer (voice hangup mid-reply). Without this
  // the `codex` CLI keeps running and burning tokens on text nobody
  // reads.
  const controller = new AbortController();
  const merged: RunEaOptions = {
    ...options,
    signal: combineSignals(options.signal, controller.signal),
  };

  const queue: string[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;

  const notify = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const task = runEa(prompt, {
    ...merged,
    onChunk: (delta) => {
      queue.push(delta);
      options.onChunk?.(delta);
      notify();
    },
  })
    .then((result) => {
      if (!result.success) {
        error = new Error(result.error ?? "ea stream failed");
      }
    })
    .catch((err) => {
      error = err instanceof Error ? err : new Error(String(err));
    })
    .finally(() => {
      done = true;
      notify();
    });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) {
        // Ensure the underlying promise has fully settled (so `error` is
        // set if the run failed) and propagate any error to the caller.
        await task;
        if (error) throw error;
        return;
      }
      await new Promise<void>((r) => (resolveNext = r));
    }
  } finally {
    // Cancels the subprocess if the caller break'd out early. No-op if
    // the run already completed normally.
    controller.abort();
  }
}

/**
 * Combine an optional external signal with an always-present internal
 * signal. Uses `AbortSignal.any` (Node 20+). Returns the internal signal
 * alone when no external signal is provided.
 */
function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (!external) return internal;
  return AbortSignal.any([external, internal]);
}
