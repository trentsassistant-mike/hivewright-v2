import { describe, it, expect } from "vitest";
import { shouldCompact, buildCompactionRequest, buildCompactedSessionPrompt } from "@/goals/compaction";

describe("shouldCompact", () => {
  it("returns false when context is small", () => {
    expect(shouldCompact(10000, 200000)).toBe(false);
  });

  it("returns true when context exceeds 70% of window", () => {
    expect(shouldCompact(150000, 200000)).toBe(true);
  });

  it("returns true at exactly 70%", () => {
    expect(shouldCompact(140000, 200000)).toBe(true);
  });

  it("returns false just below 70%", () => {
    expect(shouldCompact(139999, 200000)).toBe(false);
  });
});

describe("buildCompactionRequest", () => {
  it("returns a compaction prompt", () => {
    const prompt = buildCompactionRequest();
    expect(prompt).toContain("context is getting large");
    expect(prompt).toContain("summarise");
    expect(prompt).toContain("handover brief");
  });
});

describe("buildCompactedSessionPrompt", () => {
  it("combines original prompt with handover brief", () => {
    const result = buildCompactedSessionPrompt("Original goal prompt here", "Here is my handover summary");
    expect(result).toContain("Original goal prompt here");
    expect(result).toContain("Here is my handover summary");
    expect(result).toContain("Handover");
  });
});
