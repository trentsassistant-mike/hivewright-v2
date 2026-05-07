import { describe, it, expect } from "vitest";
import { extractFirstJsonBlock, isValidClassifierResult } from "@/work-intake/type-guard";

describe("extractFirstJsonBlock", () => {
  it("returns the JSON when the input is pure JSON", () => {
    expect(extractFirstJsonBlock('{"type":"task"}')).toBe('{"type":"task"}');
  });

  it("extracts a JSON block from prose around it", () => {
    const input = `Here is my answer:\n{"type":"goal","confidence":0.9,"reasoning":"x"}\nThanks.`;
    expect(extractFirstJsonBlock(input)).toBe('{"type":"goal","confidence":0.9,"reasoning":"x"}');
  });

  it("extracts from a fenced code block", () => {
    const input = 'prose ```json\n{"type":"task","role":"dev","confidence":1,"reasoning":"y"}\n```';
    expect(extractFirstJsonBlock(input)).toBe(
      '{"type":"task","role":"dev","confidence":1,"reasoning":"y"}',
    );
  });

  it("returns null when no JSON object is found", () => {
    expect(extractFirstJsonBlock("no json here at all")).toBeNull();
  });

  it("handles nested braces correctly", () => {
    const input = 'text {"outer": {"inner": 1}, "type": "goal"} tail';
    expect(extractFirstJsonBlock(input)).toBe('{"outer": {"inner": 1}, "type": "goal"}');
  });
});

describe("isValidClassifierResult", () => {
  it("accepts a valid task result", () => {
    expect(
      isValidClassifierResult({
        type: "task",
        role: "dev-agent",
        confidence: 0.9,
        reasoning: "because",
      }),
    ).toBe(true);
  });

  it("accepts a valid goal result", () => {
    expect(
      isValidClassifierResult({ type: "goal", confidence: 0.7, reasoning: "big scope" }),
    ).toBe(true);
  });

  it("rejects task without role", () => {
    expect(isValidClassifierResult({ type: "task", confidence: 0.9, reasoning: "x" })).toBe(false);
  });

  it("rejects unknown type", () => {
    expect(isValidClassifierResult({ type: "other", confidence: 0.9, reasoning: "x" })).toBe(false);
  });

  it("rejects confidence out of range", () => {
    expect(isValidClassifierResult({ type: "goal", confidence: 1.5, reasoning: "x" })).toBe(false);
    expect(isValidClassifierResult({ type: "goal", confidence: -0.1, reasoning: "x" })).toBe(false);
  });

  it("rejects missing reasoning", () => {
    expect(isValidClassifierResult({ type: "goal", confidence: 0.9 })).toBe(false);
  });
});
