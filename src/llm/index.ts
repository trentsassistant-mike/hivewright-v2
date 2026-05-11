import type { ChatProvider, ProviderId } from "./types";
import { OllamaChatProvider } from "./ollama";
import { OpenRouterChatProvider } from "./openrouter";

export * from "./types";
export { OllamaChatProvider } from "./ollama";
export { OpenRouterChatProvider } from "./openrouter";

export interface GetProviderOpts {
  ollamaEndpoint?: string;
  openrouterApiKey?: string;
  fetchFn?: typeof fetch;
}

export function getChatProvider(id: ProviderId, opts: GetProviderOpts = {}): ChatProvider | null {
  if (id === "none") return null;
  if (id === "ollama") {
    const endpoint = opts.ollamaEndpoint ?? process.env.OLLAMA_ENDPOINT ?? "http://192.168.50.68:11434";
    return new OllamaChatProvider(endpoint, opts.fetchFn);
  }
  if (id === "openrouter") {
    const key = opts.openrouterApiKey ?? "";
    return new OpenRouterChatProvider(key, opts.fetchFn);
  }
  return null;
}
