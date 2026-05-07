import type { ChatProvider, ChatRequest, ChatResponse } from "./types";

interface OpenRouterChoice {
  message?: {
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    refusal?: string | null;
  };
  finish_reason?: string;
  native_finish_reason?: string;
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string; code?: number };
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterChatProvider implements ChatProvider {
  readonly id = "openrouter" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.apiKey) {
      throw new Error("openrouter chat failed: OPENROUTER_API_KEY is not configured");
    }

    const body = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? 0.1,
      max_tokens: req.maxTokens ?? 512,
    };

    const signal = req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined;
    const res = await this.fetchFn(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://hivewright.local",
        "X-Title": "HiveWright v2",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`openrouter chat failed: ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OpenRouterResponse;

    if (data.error?.message) {
      throw new Error(`openrouter chat: provider error: ${data.error.message}`);
    }

    const choice = data.choices?.[0];
    const msg = choice?.message;
    const content =
      (typeof msg?.content === "string" && msg.content.length > 0 ? msg.content : null) ??
      (typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0
        ? msg.reasoning_content
        : null) ??
      (typeof msg?.reasoning === "string" && msg.reasoning.length > 0 ? msg.reasoning : null);

    if (typeof content !== "string") {
      const routedModel = data.model ?? req.model;
      const finish = choice?.finish_reason ?? choice?.native_finish_reason ?? "unknown";
      const refusal = msg?.refusal ?? null;
      const hint = refusal
        ? `refusal="${refusal}"`
        : finish === "content_filter"
          ? "blocked by content filter"
          : `finish_reason=${finish}`;
      throw new Error(
        `openrouter chat: empty content from ${routedModel} (${hint}). Try a different model.`,
      );
    }

    return {
      text: content,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      model: data.model ?? req.model,
      provider: "openrouter",
    };
  }
}
