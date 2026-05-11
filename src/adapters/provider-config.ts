export interface ModelPricing {
  inputPer1k: number;
  cachedInputPer1k?: number;
  outputPer1k: number;
}

// Pricing in cents per 1,000 tokens (USD). Keep this in sync with the
// providers you actually run; the unit tests below prove costs are computed
// for every model a task might report. When a model is missing we fall
// back to a rough GPT-4o-class estimate so cost-spend never silently reads
// as $0 — the dashboard and budget checks become meaningless otherwise.
const PRICING: Record<string, ModelPricing> = {
  // Anthropic via OpenRouter / direct
  "anthropic/claude-sonnet-4-6": { inputPer1k: 0.3, outputPer1k: 1.5 },
  "anthropic/claude-sonnet-4-5": { inputPer1k: 0.3, outputPer1k: 1.5 },
  "anthropic/claude-opus-4-7": { inputPer1k: 1.5, outputPer1k: 7.5 },
  "anthropic/claude-opus-4-6": { inputPer1k: 1.5, outputPer1k: 7.5 },
  // OpenAI / OpenAI-compatible
  "openai/gpt-5.5": { inputPer1k: 0.5, cachedInputPer1k: 0.05, outputPer1k: 3.0 },
  // Internal codex routing alias only. OpenAI's public API model ID is `gpt-5.5`.
  "openai-codex/gpt-5.5": { inputPer1k: 0.5, cachedInputPer1k: 0.05, outputPer1k: 3.0 },
  "openai/gpt-4o": { inputPer1k: 0.25, outputPer1k: 1.0 },
  "openai/gpt-4o-mini": { inputPer1k: 0.015, outputPer1k: 0.06 },
  "openai-codex/gpt-5.4": { inputPer1k: 0.25, outputPer1k: 1.0 },
  "openai/gpt-5.4": { inputPer1k: 0.25, outputPer1k: 1.0 },
  "gpt-image-2": { inputPer1k: 0.8, outputPer1k: 3.0 },
  "gpt-image-2-2026-04-21": { inputPer1k: 0.8, outputPer1k: 3.0 },
  // Mistral
  "mistral/mistral-large-latest": { inputPer1k: 0.05, outputPer1k: 0.15 },
  "mistral/mistral-ocr-latest": { inputPer1k: 0.05, outputPer1k: 0.15 },
  // Google
  "google/gemini-2.0-flash-exp:free": { inputPer1k: 0, outputPer1k: 0 },
  "gemini-2.0-flash-exp:free": { inputPer1k: 0, outputPer1k: 0 },
  "google/gemini-2.5-flash": { inputPer1k: 0.015, outputPer1k: 0.06 },
  "gemini-2.5-flash": { inputPer1k: 0.015, outputPer1k: 0.06 },
  "google/gemini-2.5-pro": { inputPer1k: 0.125, outputPer1k: 0.5 },
  "gemini-2.5-pro": { inputPer1k: 0.125, outputPer1k: 0.5 },
  "google/gemini-3.1-pro-preview": { inputPer1k: 0.2, outputPer1k: 1.2 },
  "gemini-3.1-pro-preview": { inputPer1k: 0.2, outputPer1k: 1.2 },
  "google/gemini-3.1-pro-preview-customtools": { inputPer1k: 0.2, outputPer1k: 1.2 },
  "gemini-3.1-pro-preview-customtools": { inputPer1k: 0.2, outputPer1k: 1.2 },
  "google/gemini-3.1-flash-lite-preview": { inputPer1k: 0.2, outputPer1k: 1.2 },
  "gemini-3.1-flash-lite-preview": { inputPer1k: 0.2, outputPer1k: 1.2 },
  "google/gemini-3-flash-preview": { inputPer1k: 0.2, outputPer1k: 1.2 },
  "gemini-3-flash-preview": { inputPer1k: 0.2, outputPer1k: 1.2 },
  // OpenRouter free tier aliases (cost = 0)
  "openrouter/google/gemma-4-26b-a4b:free": { inputPer1k: 0, outputPer1k: 0 },
  "openrouter/meta-llama/llama-3.2-3b-instruct:free": { inputPer1k: 0, outputPer1k: 0 },
  // Local models — zero API cost
  "ollama/gemma4:26b": { inputPer1k: 0, outputPer1k: 0 },
  "ollama/qwen3.5:27b": { inputPer1k: 0, outputPer1k: 0 },
  "ollama/qwen3:32b": { inputPer1k: 0, outputPer1k: 0 },
  "ollama/mistral": { inputPer1k: 0, outputPer1k: 0 },
};

/**
 * When a model isn't in the pricing map, treat it as GPT-4o-class so costs
 * aren't silently zeroed. Cheaper than missing budget alerts.
 */
const FALLBACK_PRICING: ModelPricing = { inputPer1k: 0.25, outputPer1k: 1.0 };

// Ollama endpoint on GPU machine (same LAN). Lazily read so importing this
// module from client components doesn't trip Next's process.env inline.
function ollamaEndpoint(): string {
  return process.env.OLLAMA_ENDPOINT || "http://192.168.50.68:11434";
}

export function getProviderEndpoint(provider: string): string | null {
  if (provider === "ollama") return ollamaEndpoint();
  return null;
}

export function getModelEndpoint(model: string): string {
  return model.split("/")[0];
}

export function getModelPricing(model: string): ModelPricing | null {
  return PRICING[model] ?? null;
}

export function getEffectiveModelPricing(model: string): ModelPricing {
  return getModelPricing(model) ?? FALLBACK_PRICING;
}

export function getKnownModelIds(): string[] {
  return Object.keys(PRICING);
}

export function resolveModel(recommendedModel: string, override: string | null): string {
  return override ?? recommendedModel;
}

export function calculateCostCents(model: string, tokensInput: number, tokensOutput: number): number {
  const pricing = getEffectiveModelPricing(model);
  return Math.round(
    (tokensInput / 1000) * pricing.inputPer1k +
      (tokensOutput / 1000) * pricing.outputPer1k,
  );
}
