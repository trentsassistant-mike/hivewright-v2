export type ProviderId = "ollama" | "openrouter" | "none";

export interface ChatRequest {
  system: string;
  user: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  provider: ProviderId;
}

export interface ChatProvider {
  readonly id: ProviderId;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
