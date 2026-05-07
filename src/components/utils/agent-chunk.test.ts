import { describe, it, expect } from "vitest";
import { shapeAgentChunk } from "./agent-chunk";

describe("shapeAgentChunk", () => {
  it("passes short lines through unchanged", () => {
    const r = shapeAgentChunk("hello world\n");
    expect(r.display).toBe("hello world\n");
    expect(r.summarised).toBe(false);
    expect(r.originalBytes).toBe(12);
  });

  it("preserves streaming partials so they concat naturally", () => {
    const a = shapeAgentChunk("hello");
    const b = shapeAgentChunk(" world");
    expect(a.display + b.display).toBe("hello world");
  });

  it("truncates long plain text with a byte-count hint", () => {
    const long = "x".repeat(5000);
    const r = shapeAgentChunk(long);
    expect(r.summarised).toBe(true);
    expect(r.originalBytes).toBe(5000);
    expect(r.display).toContain("KB truncated");
    expect(r.display.length).toBeLessThan(900);
  });

  it("collapses OpenClaw session-meta JSON to one line", () => {
    const meta =
      '{"payloads":[{"text":"Request timed out"}],"meta":{"durationMs":313648,"livenessState":"blocked","replayInvalid":true,"agentMeta":{"sessionId":"x"}}}' +
      "X".repeat(20_000);
    const r = shapeAgentChunk(meta);
    expect(r.summarised).toBe(true);
    expect(r.display).toContain("session diagnostic");
    expect(r.display).toContain("collapsed");
    expect(r.display).not.toContain('"agentMeta"');
  });

  it("does NOT collapse plausibly meta-shaped but short JSON", () => {
    const short = '{"livenessState":"blocked"}';
    const r = shapeAgentChunk(short);
    expect(r.summarised).toBe(false);
    expect(r.display).toBe(short);
  });
});
