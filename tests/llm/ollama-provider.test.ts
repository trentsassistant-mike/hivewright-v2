import { describe, it, expect, vi } from "vitest";
import { OllamaChatProvider } from "@/llm/ollama";

describe("OllamaChatProvider", () => {
  it("returns parsed ChatResponse on success", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
          model: "qwen3:32b",
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const provider = new OllamaChatProvider("http://ollama:11434", fetchFn);
    const res = await provider.chat({
      system: "sys",
      user: "hi",
      model: "qwen3:32b",
    });
    expect(res.text).toBe("hello");
    expect(res.tokensIn).toBe(12);
    expect(res.tokensOut).toBe(3);
    expect(res.provider).toBe("ollama");
    expect(res.model).toBe("qwen3:32b");
  });

  it("throws on non-200 HTTP status", async () => {
    const fetchFn = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const provider = new OllamaChatProvider("http://ollama:11434", fetchFn);
    await expect(
      provider.chat({ system: "", user: "x", model: "qwen3:32b" }),
    ).rejects.toThrow(/ollama.*500/i);
  });

  it("throws on missing choices", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = new OllamaChatProvider("http://ollama:11434", fetchFn);
    await expect(
      provider.chat({ system: "", user: "x", model: "qwen3:32b" }),
    ).rejects.toThrow(/missing.*choices/i);
  });

  it("propagates AbortError on timeout", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
      throw new Error("should not reach here");
    }) as unknown as typeof fetch;
    const provider = new OllamaChatProvider("http://ollama:11434", fetchFn);
    await expect(
      provider.chat({ system: "", user: "x", model: "qwen3:32b", timeoutMs: 10 }),
    ).rejects.toThrow(/abort/i);
  });
});
