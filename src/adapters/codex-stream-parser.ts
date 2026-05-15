/**
 * Pure parser for `codex exec --json` JSONL output.
 *
 * The codex CLI emits one JSON object per line. We care about three event types:
 *   - `thread.started` — session opened (carries thread_id for `--resume`)
 *   - `item.completed` with `item.type === "agent_message"` — assistant text
 *   - `turn.completed` — terminal envelope with usage
 *
 * Other events (turn.started, item.started, tool calls, reasoning blocks) are
 * captured into `texts` only when they carry visible agent_message content;
 * everything else is ignored to keep the live-stream readable.
 */

export type ParsedCodexLine =
  | { kind: "text"; text: string }
  | {
      kind: "result";
      threadId: string | null;
      tokensInput?: number;
      freshInputTokens?: number;
      cachedInputTokens?: number;
      cachedInputTokensKnown?: boolean;
      tokensOutput?: number;
      modelUsed?: string;
      isError: boolean;
      errorMessage?: string;
    }
  | { kind: "ignore" };

interface RawCodexEvent {
  type?: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  model?: string;
  error?: string | { message?: string };
}

export function parseCodexLine(line: string): ParsedCodexLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };

  let parsed: RawCodexEvent;
  try {
    parsed = JSON.parse(trimmed) as RawCodexEvent;
  } catch {
    return { kind: "ignore" };
  }

  if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
    return { kind: "text", text: parsed.item.text };
  }

  if (parsed.type === "turn.completed") {
    const freshInputTokens = parsed.usage?.input_tokens;
    const cachedInputTokens = parsed.usage?.cached_input_tokens;
    const totalInputTokens = (freshInputTokens ?? 0) + (cachedInputTokens ?? 0);
    return {
      kind: "result",
      threadId: null,
      tokensInput: totalInputTokens,
      freshInputTokens,
      ...(parsed.usage?.cached_input_tokens !== undefined
        ? {
            cachedInputTokens,
            cachedInputTokensKnown: true,
          }
        : {}),
      tokensOutput: parsed.usage?.output_tokens,
      modelUsed: parsed.model,
      isError: false,
    };
  }

  if (parsed.type === "error" || parsed.type === "turn.failed") {
    const errorMessage = typeof parsed.error === "string"
      ? parsed.error
      : parsed.error?.message || "codex reported error";
    return {
      kind: "result",
      threadId: null,
      isError: true,
      errorMessage,
    };
  }

  return { kind: "ignore" };
}

type CodexResultEvent = Extract<ParsedCodexLine, { kind: "result" }>;

export interface CodexChunkerOutput {
  /** Accumulated assistant text deltas pulled from item.completed events. */
  texts: string[];
  /** Set on the first parsed terminal event (turn.completed or error). */
  result: CodexResultEvent | null;
  /** Captured from thread.started — used for --resume on subsequent turns. */
  threadId: string | null;
}

/**
 * Stateful line buffer for codex JSONL output. Mirrors the StreamJsonChunker
 * shape used by the claude-code adapter so the calling code stays symmetric.
 */
export class CodexJsonChunker {
  private buffer = "";
  private resultCaptured: CodexResultEvent | null = null;
  private threadId: string | null = null;

  feed(text: string): CodexChunkerOutput {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    // Keep the last (possibly partial) line in the buffer.
    this.buffer = lines.pop() ?? "";

    const texts: string[] = [];
    for (const line of lines) {
      // Capture thread_id from thread.started without producing visible text.
      if (line.includes('"thread.started"')) {
        try {
          const ev = JSON.parse(line.trim()) as RawCodexEvent;
          if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
            this.threadId = ev.thread_id;
          }
        } catch { /* ignore */ }
      }

      const parsed = parseCodexLine(line);
      if (parsed.kind === "text") {
        texts.push(parsed.text);
      } else if (parsed.kind === "result" && this.resultCaptured === null) {
        this.resultCaptured = parsed;
      }
    }

    return { texts, result: this.resultCaptured, threadId: this.threadId };
  }

  flush(): CodexChunkerOutput {
    const tailText = this.buffer.trim();
    this.buffer = "";

    const texts: string[] = [];
    if (tailText) {
      const parsed = parseCodexLine(tailText);
      if (parsed.kind === "text") {
        texts.push(parsed.text);
      } else if (parsed.kind === "result" && this.resultCaptured === null) {
        this.resultCaptured = parsed;
      }
    }
    return { texts, result: this.resultCaptured, threadId: this.threadId };
  }
}
