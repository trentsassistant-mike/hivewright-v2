import { describe, it, expect, vi } from "vitest";
import { OpenRouterChatProvider } from "@/llm/openrouter";

describe("OpenRouterChatProvider", () => {
  it("returns parsed ChatResponse on success", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("openrouter.ai/api/v1/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "world" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          model: "google/gemini-2.0-flash-exp:free",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenRouterChatProvider("test-key", fetchFn);
    const res = await provider.chat({
      system: "sys",
      user: "hi",
      model: "google/gemini-2.0-flash-exp:free",
    });
    expect(res.text).toBe("world");
    expect(res.provider).toBe("openrouter");
    expect(res.tokensIn).toBe(5);
    expect(res.tokensOut).toBe(2);
  });

  it("throws with descriptive message when API key is empty", async () => {
    const provider = new OpenRouterChatProvider("", vi.fn() as unknown as typeof fetch);
    await expect(
      provider.chat({ system: "", user: "x", model: "m" }),
    ).rejects.toThrow(/api_key/i);
  });

  it("throws on non-200 HTTP status", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const provider = new OpenRouterChatProvider("test-key", fetchFn);
    await expect(
      provider.chat({ system: "", user: "x", model: "m" }),
    ).rejects.toThrow(/openrouter.*401/i);
  });

  it("throws on missing choices", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = new OpenRouterChatProvider("test-key", fetchFn);
    await expect(
      provider.chat({ system: "", user: "x", model: "m" }),
    ).rejects.toThrow(/empty content/i);
  });
});
