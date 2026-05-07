import { describe, it, expect, vi } from "vitest";
import { validateBriefWithLLM } from "@/dispatcher/pre-task-qa";
import type { ModelCallerConfig } from "@/memory/model-caller";

describe("validateBriefWithLLM", () => {
  it("passes when LLM says task is well-formed", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ response: '{"passed": true, "issues": []}' }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434", generationModel: "mistral", embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };

    const result = await validateBriefWithLLM({
      title: "Fix login bug", brief: "The login form returns 500 on submit. Fix the auth handler.",
      acceptanceCriteria: "Login form submits successfully and returns 200", assignedTo: "dev-agent", roleType: "executor",
    }, config);

    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns issues when LLM flags problems", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ response: '{"passed": false, "issues": ["Brief is too vague", "No acceptance criteria"]}' }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434", generationModel: "mistral", embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };

    const result = await validateBriefWithLLM({
      title: "Do stuff", brief: "Do the thing", acceptanceCriteria: null, assignedTo: "dev-agent", roleType: "executor",
    }, config);

    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("passes through when LLM call fails", async () => {
    const mockFetch = vi.fn(async () => new Response("error", { status: 500 }));
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434", generationModel: "mistral", embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };

    const result = await validateBriefWithLLM({
      title: "Test", brief: "Test brief", acceptanceCriteria: null, assignedTo: "dev-agent", roleType: "executor",
    }, config);

    expect(result.passed).toBe(true); // Graceful fallback
  });
});
