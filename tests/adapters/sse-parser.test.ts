import { describe, it, expect } from "vitest";
import { parseSseEvent, SseChunker } from "@/adapters/sse-parser";

describe("parseSseEvent", () => {
  it("returns text event for delta with content", () => {
    const event = `data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`;
    expect(parseSseEvent(event)).toEqual({ kind: "text", text: "Hello" });
  });

  it("returns done event for [DONE] marker", () => {
    expect(parseSseEvent("data: [DONE]")).toEqual({ kind: "done" });
  });

  it("returns usage event for terminal frame with usage and finish_reason", () => {
    const event = `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":2}}`;
    expect(parseSseEvent(event)).toEqual({
      kind: "usage",
      tokensInput: 15,
      tokensOutput: 2,
    });
  });

  it("ignores frames with empty delta and no usage (the role-init frame)", () => {
    const event = `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`;
    expect(parseSseEvent(event)).toEqual({ kind: "ignore" });
  });

  it("ignores comments and unknown event types", () => {
    expect(parseSseEvent(": ping")).toEqual({ kind: "ignore" });
    expect(parseSseEvent("event: something")).toEqual({ kind: "ignore" });
    expect(parseSseEvent("")).toEqual({ kind: "ignore" });
  });

  it("ignores malformed JSON in data: payload", () => {
    expect(parseSseEvent("data: {not json")).toEqual({ kind: "ignore" });
  });
});

describe("SseChunker", () => {
  it("emits one event per data: ... blank-line block", () => {
    const chunker = new SseChunker();
    const out = chunker.feed(
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":" there"}}]}\n\n`
    );
    expect(out.texts).toEqual(["Hi", " there"]);
    expect(out.done).toBe(false);
    expect(out.usage).toBeNull();
  });

  it("buffers partial events across feed() calls", () => {
    const chunker = new SseChunker();
    const a = chunker.feed(`data: {"choices":[{"delta":{"content":"Hel`);
    expect(a.texts).toEqual([]);
    const b = chunker.feed(`lo"}}]}\n\n`);
    expect(b.texts).toEqual(["Hello"]);
  });

  it("captures usage from the penultimate frame and done from [DONE]", () => {
    const chunker = new SseChunker();
    const out = chunker.feed(
      `data: {"choices":[{"delta":{"content":"x"}}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n` +
      `data: [DONE]\n\n`
    );
    expect(out.texts).toEqual(["x"]);
    expect(out.usage).toEqual({ tokensInput: 3, tokensOutput: 1 });
    expect(out.done).toBe(true);
  });
});
