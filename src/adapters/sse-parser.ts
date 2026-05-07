/**
 * Pure parser for OpenAI-compatible Server-Sent Events streams.
 *
 * Used by the ollama adapter to consume token-level deltas from the
 * `/v1/chat/completions` endpoint when `stream: true` is requested.
 *
 * Event grammar (per OpenAI spec):
 *   data: <json>\n\n        — one streaming chunk
 *   data: [DONE]\n\n        — terminator
 *   : <comment>\n\n         — heartbeat / keep-alive
 *
 * Each chunk's `choices[0].delta.content` (when present) is the renderable
 * token. The frame with `finish_reason: "stop"` typically carries the final
 * token-usage breakdown.
 */

export type ParsedSseEvent =
  | { kind: "text"; text: string }
  | { kind: "usage"; tokensInput?: number; tokensOutput?: number }
  | { kind: "done" }
  | { kind: "ignore" };

interface SseChunkPayload {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parseSseEvent(event: string): ParsedSseEvent {
  const trimmed = event.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return { kind: "ignore" };
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return { kind: "done" };

  let parsed: SseChunkPayload;
  try {
    parsed = JSON.parse(payload) as SseChunkPayload;
  } catch {
    return { kind: "ignore" };
  }

  const delta = parsed.choices?.[0]?.delta;
  const finish = parsed.choices?.[0]?.finish_reason;
  const usage = parsed.usage;

  if (typeof delta?.content === "string" && delta.content.length > 0) {
    return { kind: "text", text: delta.content };
  }

  if (finish && usage) {
    return {
      kind: "usage",
      tokensInput: usage.prompt_tokens,
      tokensOutput: usage.completion_tokens,
    };
  }

  return { kind: "ignore" };
}

export interface SseChunkerOutput {
  texts: string[];
  usage: { tokensInput?: number; tokensOutput?: number } | null;
  done: boolean;
}

/**
 * Stateful chunker for SSE byte streams. Events terminate on `\n\n`; this
 * class accumulates partial bytes between feed() calls.
 *
 * Note: deliberately no flush() method (unlike sibling StreamJsonChunker).
 * Well-formed SSE always ends with `data: [DONE]\n\n`; trailing bytes after
 * the last terminator are by definition a truncated event and intentionally
 * discarded — surfacing a half-event would risk corrupt output.
 */
export class SseChunker {
  private buffer = "";
  private capturedUsage: SseChunkerOutput["usage"] = null;
  private sawDone = false;

  feed(chunk: string): SseChunkerOutput {
    // No buffer-size cap: a pathological never-terminating stream is bounded
    // by the consuming adapter's HTTP timeout (e.g. ollama adapter caps at
    // 600s). If we ever consume an SSE source without a timeout boundary,
    // this needs an explicit cap.
    this.buffer += chunk;
    const texts: string[] = [];
    let sepIdx: number;
    while ((sepIdx = this.buffer.indexOf("\n\n")) !== -1) {
      const event = this.buffer.slice(0, sepIdx);
      this.buffer = this.buffer.slice(sepIdx + 2);
      const parsed = parseSseEvent(event);
      if (parsed.kind === "text") texts.push(parsed.text);
      else if (parsed.kind === "usage") {
        this.capturedUsage = { tokensInput: parsed.tokensInput, tokensOutput: parsed.tokensOutput };
      } else if (parsed.kind === "done") {
        this.sawDone = true;
      }
    }
    return { texts, usage: this.capturedUsage, done: this.sawDone };
  }
}
