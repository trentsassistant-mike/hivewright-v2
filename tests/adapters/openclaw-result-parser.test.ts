import { describe, it, expect } from "vitest";
import { extractCleanResult } from "@/adapters/openclaw-result-parser";

describe("extractCleanResult", () => {
  it("returns joined payload texts and token usage from a complete envelope", () => {
    const stdout = JSON.stringify({
      runId: "abc",
      status: "ok",
      summary: "completed",
      result: {
        payloads: [
          { text: "Sprint replanned." },
          { text: "Created 3 tasks." },
        ],
        meta: {
          agentMeta: {
            usage: { input: 12345, output: 678 },
            model: "claude-opus-4-6",
          },
        },
      },
    });
    expect(extractCleanResult(stdout)).toEqual({
      text: "Sprint replanned.\n\nCreated 3 tasks.",
      tokensInput: 12345,
      tokensOutput: 678,
      modelUsed: "claude-opus-4-6",
    });
  });

  it("falls back to result-as-string when payloads are absent", () => {
    const stdout = JSON.stringify({
      runId: "abc",
      status: "ok",
      result: "Plain string result.",
    });
    expect(extractCleanResult(stdout)).toEqual({
      text: "Plain string result.",
      tokensInput: undefined,
      tokensOutput: undefined,
      modelUsed: undefined,
    });
  });

  it("falls back to top-level usage/model fields when meta is missing", () => {
    const stdout = JSON.stringify({
      runId: "abc",
      status: "ok",
      result: { payloads: [{ text: "Hi" }] },
      usage: { input_tokens: 5, output_tokens: 3 },
      model: "ollama/qwen3:32b",
    });
    expect(extractCleanResult(stdout)).toEqual({
      text: "Hi",
      tokensInput: 5,
      tokensOutput: 3,
      modelUsed: "ollama/qwen3:32b",
    });
  });

  it("ignores empty payload texts", () => {
    const stdout = JSON.stringify({
      result: { payloads: [{ text: "real" }, { text: "" }, {}] },
    });
    expect(extractCleanResult(stdout)?.text).toBe("real");
  });

  it("returns null on malformed JSON", () => {
    expect(extractCleanResult("not json")).toBeNull();
    expect(extractCleanResult("")).toBeNull();
  });

  it("returns null on non-object JSON (null, number, bool, string)", () => {
    expect(extractCleanResult("null")).toBeNull();
    expect(extractCleanResult("42")).toBeNull();
    expect(extractCleanResult('"hi"')).toBeNull();
    expect(extractCleanResult("true")).toBeNull();
  });

  it("returns null when no extractable text is found", () => {
    const stdout = JSON.stringify({ runId: "x", status: "ok" });
    expect(extractCleanResult(stdout)).toBeNull();
  });
});
