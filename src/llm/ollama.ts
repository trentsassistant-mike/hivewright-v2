import type { ChatProvider, ChatRequest, ChatResponse } from "./types";

interface OllamaChoice { message: { content: string } }
interface OllamaResponse {
  choices?: OllamaChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export class OllamaChatProvider implements ChatProvider {
  readonly id = "ollama" as const;

  constructor(
    private readonly endpoint: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.endpoint.replace(/\/+$/, "")}/v1/chat/completions`;
    const body = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? 0.1,
      max_tokens: req.maxTokens ?? 512,
      stream: false,
    };

    const signal = req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama chat failed: ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OllamaResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("ollama chat: missing choices[0].message.content");
    }

    return {
      text: content,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      model: data.model ?? req.model,
      provider: "ollama",
    };
  }
}
