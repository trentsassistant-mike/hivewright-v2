import { describe, it, expect } from "vitest";
import { parseStreamJsonLine, StreamJsonChunker } from "@/adapters/claude-stream-parser";

describe("parseStreamJsonLine", () => {
  it("returns text-delta event for content_block_delta with text_delta", () => {
    const line = `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}},"session_id":"s","uuid":"u"}`;
    const result = parseStreamJsonLine(line);
    expect(result).toEqual({ kind: "text", text: "Hello" });
  });

  it("ignores thinking_delta events (internal, not user-visible)", () => {
    const line = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning..."}},"session_id":"s","uuid":"u"}`;
    expect(parseStreamJsonLine(line)).toEqual({ kind: "ignore" });
  });

  it("ignores signature_delta events (internal cryptographic signatures)", () => {
    const line = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"Er0i..."}},"session_id":"s","uuid":"u"}`;
    expect(parseStreamJsonLine(line)).toEqual({ kind: "ignore" });
  });

  it("ignores hook lifecycle events", () => {
    const line = `{"type":"system","subtype":"hook_started","hook_id":"h","hook_name":"SessionStart:startup","uuid":"u","session_id":"s"}`;
    expect(parseStreamJsonLine(line)).toEqual({ kind: "ignore" });
  });

  it("returns result event for terminal {type:result} envelope with token usage", () => {
    const line = `{"type":"result","subtype":"success","is_error":false,"duration_ms":12180,"num_turns":1,"result":"Hi there!","usage":{"input_tokens":9,"output_tokens":1057},"modelUsage":{"claude-haiku-4-5":{"inputTokens":9,"outputTokens":1057}},"terminal_reason":"completed","uuid":"u","session_id":"s","total_cost_usd":0.077}`;
    const result = parseStreamJsonLine(line);
    expect(result).toEqual({
      kind: "result",
      result: "Hi there!",
      tokensInput: 9,
      tokensOutput: 1057,
      modelUsed: "claude-haiku-4-5",
      isError: false,
      errorSubtype: undefined,
    });
  });

  it("normalizes Claude cache creation and cache read usage into total input", () => {
    const line = `{"type":"result","subtype":"success","is_error":false,"result":"Done","usage":{"input_tokens":600,"cache_creation_input_tokens":100,"cache_read_input_tokens":300,"output_tokens":125},"modelUsage":{"claude-haiku-4-5":{}},"uuid":"u","session_id":"s"}`;
    const result = parseStreamJsonLine(line);

    expect(result).toMatchObject({
      kind: "result",
      tokensInput: 1_000,
      freshInputTokens: 700,
      cachedInputTokens: 300,
      cacheCreationTokens: 100,
      cachedInputTokensKnown: true,
      tokensOutput: 125,
    });
  });

  it("returns result event for error_max_turns terminal envelope", () => {
    const line = `{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":50,"result":"","uuid":"u","session_id":"s"}`;
    const result = parseStreamJsonLine(line);
    expect(result).toMatchObject({ kind: "result", isError: true, errorSubtype: "error_max_turns" });
  });

  it("ignores all other stream_event types (assistant snapshot, message_delta, rate_limit, etc)", () => {
    const lines = [
      `{"type":"assistant","message":{"id":"m"},"uuid":"u","session_id":"s","parent_tool_use_id":null}`,
      `{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":9,"output_tokens":1057}},"session_id":"s","uuid":"u"}`,
      `{"type":"stream_event","event":{"type":"message_stop"},"session_id":"s","uuid":"u"}`,
      `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"uuid":"u","session_id":"s"}`,
      `{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}},"session_id":"s","uuid":"u"}`,
      `{"type":"stream_event","event":{"type":"content_block_stop","index":1},"session_id":"s","uuid":"u"}`,
    ];
    for (const line of lines) {
      expect(parseStreamJsonLine(line), `expected ignore for: ${line.slice(0, 60)}`).toEqual({ kind: "ignore" });
    }
  });

  it("returns ignore on malformed JSON (claude sometimes emits partial lines)", () => {
    expect(parseStreamJsonLine(`{"type":"stream_event","event":{`)).toEqual({ kind: "ignore" });
  });

  it("returns ignore on empty line", () => {
    expect(parseStreamJsonLine("")).toEqual({ kind: "ignore" });
    expect(parseStreamJsonLine("   ")).toEqual({ kind: "ignore" });
  });
});

describe("StreamJsonChunker", () => {
  it("emits one text event per complete line", () => {
    const chunker = new StreamJsonChunker();
    const out = chunker.feed(
      `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}},"session_id":"s","uuid":"u"}\n` +
      `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" world"}},"session_id":"s","uuid":"u"}\n`
    );
    expect(out.texts).toEqual(["Hello", " world"]);
    expect(out.result).toBeNull();
  });

  it("buffers partial lines across feed() calls", () => {
    const chunker = new StreamJsonChunker();
    const a = chunker.feed(`{"type":"stream_event","event":{"type":"content_block_delta","index":1,`);
    expect(a.texts).toEqual([]);
    const b = chunker.feed(`"delta":{"type":"text_delta","text":"Hi"}},"session_id":"s","uuid":"u"}\n`);
    expect(b.texts).toEqual(["Hi"]);
  });

  it("captures the final result envelope and exposes token usage", () => {
    const chunker = new StreamJsonChunker();
    const out = chunker.feed(
      `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}},"session_id":"s","uuid":"u"}\n` +
      `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"num_turns":1,"result":"Done","usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"claude-haiku-4-5":{}},"terminal_reason":"completed","uuid":"u","session_id":"s"}\n`
    );
    expect(out.texts).toEqual(["Done"]);
    expect(out.result).toEqual({
      kind: "result",
      result: "Done",
      tokensInput: 3,
      tokensOutput: 2,
      modelUsed: "claude-haiku-4-5",
      isError: false,
      errorSubtype: undefined,
    });
  });

  it("flush() returns no texts but preserves the captured result envelope", () => {
    const chunker = new StreamJsonChunker();
    chunker.feed(`{"type":"result","subtype":"success","is_error":false,"result":"x","usage":{"input_tokens":1,"output_tokens":1},"modelUsage":{"claude-haiku-4-5":{}},"uuid":"u","session_id":"s"}\n`);
    const out = chunker.flush();
    expect(out.texts).toEqual([]);
    expect(out.result).toMatchObject({ kind: "result", result: "x" });
  });

  it("flush() drains a final unterminated line as best-effort", () => {
    const chunker = new StreamJsonChunker();
    chunker.feed(`{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"tail"}},"session_id":"s","uuid":"u"}`);
    const out = chunker.flush();
    expect(out.texts).toEqual(["tail"]);
  });
});
