/**
 * Pure parser for `claude --output-format stream-json --verbose --include-partial-messages` lines.
 *
 * Filters the raw event stream down to two things the dispatcher cares about:
 *   - text deltas (the assistant's natural-language output, token-by-token)
 *   - the terminal `result` envelope (final text + token usage)
 *
 * Everything else (thinking, signatures, hooks, assistant snapshots, rate-limit,
 * tool calls) is ignored. Tool-call rendering is intentionally out of scope for
 * Plan 4.5 — see the plan doc.
 */

export type ParsedStreamLine =
  | { kind: "text"; text: string }
  | {
      kind: "result";
      result: string;
      tokensInput?: number;
      freshInputTokens?: number;
      cachedInputTokens?: number;
      cachedInputTokensKnown?: boolean;
      tokensOutput?: number;
      modelUsed?: string;
      isError: boolean;
      errorSubtype?: string;
    }
  | { kind: "ignore" };

interface RawEvent {
  type?: string;
  subtype?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export function parseStreamJsonLine(line: string): ParsedStreamLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };

  let parsed: RawEvent;
  try {
    parsed = JSON.parse(trimmed) as RawEvent;
  } catch {
    return { kind: "ignore" };
  }

  if (parsed.type === "stream_event" && parsed.event?.type === "content_block_delta") {
    const delta = parsed.event.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return { kind: "text", text: delta.text };
    }
    return { kind: "ignore" };
  }

  if (parsed.type === "result") {
    const modelUsed = parsed.modelUsage ? Object.keys(parsed.modelUsage)[0] : undefined;
    const freshInputTokens =
      (parsed.usage?.input_tokens ?? 0) +
      (parsed.usage?.cache_creation_input_tokens ?? 0);
    const cachedInputTokens = parsed.usage?.cache_read_input_tokens;
    const hasCacheMetadata =
      parsed.usage?.cache_creation_input_tokens !== undefined ||
      cachedInputTokens !== undefined;
    return {
      kind: "result",
      result: typeof parsed.result === "string" ? parsed.result : "",
      tokensInput: hasCacheMetadata
        ? freshInputTokens + (cachedInputTokens ?? 0)
        : parsed.usage?.input_tokens,
      ...(hasCacheMetadata
        ? {
            freshInputTokens,
            cachedInputTokens: cachedInputTokens ?? 0,
            cachedInputTokensKnown: true,
          }
        : {}),
      tokensOutput: parsed.usage?.output_tokens,
      modelUsed,
      isError: parsed.is_error === true,
      errorSubtype: parsed.is_error === true ? parsed.subtype : undefined,
    };
  }

  return { kind: "ignore" };
}

type ResultEvent = Extract<ParsedStreamLine, { kind: "result" }>;

export interface ChunkerOutput {
  texts: string[];
  /** Set on the first parsed `result` envelope; subsequent envelopes are ignored. */
  result: ResultEvent | null;
}

/**
 * Stateful line-buffer for stream-json output. Stdout chunks from the
 * subprocess can split on arbitrary byte boundaries — this class accumulates
 * partial bytes and only invokes `parseStreamJsonLine` on complete `\n`-
 * terminated lines.
 */
export class StreamJsonChunker {
  private buffer = "";
  private capturedResult: ResultEvent | null = null;

  feed(chunk: string): ChunkerOutput {
    this.buffer += chunk;
    const texts: string[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const parsed = parseStreamJsonLine(line);
      if (parsed.kind === "text") texts.push(parsed.text);
      else if (parsed.kind === "result" && this.capturedResult === null) {
        this.capturedResult = parsed;
      }
    }
    return { texts, result: this.capturedResult };
  }

  flush(): ChunkerOutput {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (!tail) return { texts: [], result: this.capturedResult };
    const parsed = parseStreamJsonLine(tail);
    const texts: string[] = [];
    if (parsed.kind === "text") texts.push(parsed.text);
    else if (parsed.kind === "result" && this.capturedResult === null) {
      this.capturedResult = parsed;
    }
    return { texts, result: this.capturedResult };
  }
}
