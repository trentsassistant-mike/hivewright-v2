import { describe, it, expect, vi } from "vitest";
import { OllamaAdapter } from "@/adapters/ollama";
import type { SessionContext, RoleContext, MemoryContext, ChunkCallback } from "@/adapters/types";
import type { ClaimedTask } from "@/dispatcher/types";

const mockTask: ClaimedTask = {
  id: "test-id", hiveId: "biz-id", assignedTo: "dev-agent", createdBy: "owner",
  status: "active", priority: 5, title: "Test task", brief: "Do the thing",
  parentTaskId: null, goalId: null, sprintNumber: null, qaRequired: false,
  acceptanceCriteria: "It works", retryCount: 0, doctorAttempts: 0, failureReason: null,
  projectId: null,
};

const mockRole: RoleContext = { slug: "dev-agent", department: "engineering", roleMd: "# Dev Agent", soulMd: "Be thorough.", toolsMd: "Use the terminal." };
const mockMemory: MemoryContext = {
  roleMemory: [{ content: "API uses OAuth2", confidence: 0.9, updatedAt: new Date() }],
  hiveMemory: [{ content: "Peak in Dec", category: "seasonal", confidence: 0.8 }],
  insights: [], capacity: "5/200",
};

function makeCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    task: mockTask, roleTemplate: mockRole, memoryContext: mockMemory,
    skills: [], standingInstructions: ["Always test"], goalContext: null,
    projectWorkspace: null, model: "ollama/qwen3:32b", credentials: {},
    fallbackModel: null,
    ...overrides,
  };
}

describe("OllamaAdapter", () => {
  const adapter = new OllamaAdapter();

  it("constructs system prompt from 5 context layers", () => {
    const prompt = adapter.translate(makeCtx());
    expect(prompt).toContain("Dev Agent");
    expect(prompt).toContain("Test task");
    expect(prompt).toContain("API uses OAuth2");
    expect(prompt).toContain("Always test");
  });

  it("extracts model name by stripping ollama/ prefix", () => {
    expect(adapter.extractModelName("ollama/qwen3:32b")).toBe("qwen3:32b");
    expect(adapter.extractModelName("ollama/mistral")).toBe("mistral");
    expect(adapter.extractModelName("qwen3:32b")).toBe("qwen3:32b");
  });

  function makeSseResponse(events: string[]): Response {
    const body = events.join("\n\n") + "\n\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("emits onChunk text events for each delta and reports token usage", async () => {
    const calls: { text: string; type: string }[] = [];
    const onChunk: ChunkCallback = async (c) => { calls.push({ text: c.text, type: c.type }); };

    const sse = [
      `data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}`,
      `data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}`,
      `data: [DONE]`,
    ];
    const mockFetch = vi.fn<typeof fetch>(async () => makeSseResponse(sse));
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const result = await adapter.execute(makeCtx(), onChunk);
      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello world");
      expect(result.tokensInput).toBe(12);
      expect(result.tokensOutput).toBe(2);
      expect(calls).toEqual([
        { text: "Hello", type: "stdout" },
        { text: " world", type: "stdout" },
      ]);
      // Verify fetch body asked for streaming
      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("succeeds without onChunk (dispatcher-less invocation path)", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
      `data: [DONE]`,
    ];
    const mockFetch = vi.fn<typeof fetch>(async () => makeSseResponse(sse));
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const result = await adapter.execute(makeCtx());
      expect(result.success).toBe(true);
      expect(result.output).toBe("hi");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("handles a stream that ends without a usage frame", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}`,
      `data: [DONE]`,
    ];
    const mockFetch = vi.fn<typeof fetch>(async () => makeSseResponse(sse));
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const result = await adapter.execute(makeCtx());
      expect(result.success).toBe(true);
      expect(result.output).toBe("hi");
      expect(result.tokensInput).toBeUndefined();
      expect(result.tokensOutput).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("handles connection refused", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => { throw new Error("fetch failed (ECONNREFUSED)"); });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const result = await adapter.execute(makeCtx());
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("Cannot connect");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("handles model not found", async () => {
    const mockFetch = vi.fn<typeof fetch>(async () => new Response("model not found", { status: 404 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const result = await adapter.execute(makeCtx());
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("Model not found");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
