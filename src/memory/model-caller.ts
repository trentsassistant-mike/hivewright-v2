import { getProviderEndpoint } from "@/adapters/provider-config";
import {
  loadEmbeddingConfig,
  type EmbeddingProvider,
} from "./embedding-config";

export interface ModelCallerConfig {
  ollamaUrl: string;
  generationModel: string;
  embeddingModel: string;
  embeddingProvider?: EmbeddingProvider;
  embeddingDimension?: number;
  endpointOverride?: string | null;
  apiKey?: string | null;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export class RetryableEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableEmbeddingError";
  }
}

export function getDefaultConfig(): ModelCallerConfig {
  return {
    ollamaUrl: getProviderEndpoint("ollama") ?? "http://localhost:11434",
    generationModel: process.env.OLLAMA_GENERATION_MODEL || "mistral",
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || "all-minilm",
  };
}

export async function callGenerationModel(
  prompt: string,
  config: ModelCallerConfig = getDefaultConfig(),
): Promise<string> {
  const fetchFn = config.fetchFn ?? fetch;
  const response = await fetchFn(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.generationModel,
      prompt,
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama generation failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { response: string };
  return data.response;
}

export async function callEmbeddingModel(
  text: string,
  config?: ModelCallerConfig,
): Promise<number[]> {
  const runtimeConfig = config ?? await getEmbeddingRuntimeConfig();
  const fetchFn = runtimeConfig.fetchFn ?? fetch;
  let embedding: number[];

  switch (runtimeConfig.embeddingProvider ?? "ollama") {
    case "ollama":
      embedding = await embedWithOllama(text, runtimeConfig, fetchFn);
      break;
    case "openai":
      embedding = await embedWithOpenAiCompatible(text, runtimeConfig, fetchFn, {
        name: "OpenAI",
        baseUrl: runtimeConfig.endpointOverride ?? "https://api.openai.com/v1",
      });
      break;
    case "openrouter":
      embedding = await embedWithOpenAiCompatible(text, runtimeConfig, fetchFn, {
        name: "OpenRouter",
        baseUrl: runtimeConfig.endpointOverride ?? "https://openrouter.ai/api/v1",
        extraHeaders: {
          "HTTP-Referer": "https://hivewright.local",
          "X-Title": "HiveWright",
        },
      });
      break;
    case "voyage":
      embedding = await embedWithVoyage(text, runtimeConfig, fetchFn);
      break;
    case "cohere":
      embedding = await embedWithCohere(text, runtimeConfig, fetchFn);
      break;
    case "mistral":
      embedding = await embedWithMistral(text, runtimeConfig, fetchFn);
      break;
    case "google":
      embedding = await embedWithGoogle(text, runtimeConfig, fetchFn);
      break;
    case "huggingface":
      embedding = await embedWithHuggingFace(text, runtimeConfig, fetchFn);
      break;
    default:
      throw new Error(`Unsupported embedding provider '${runtimeConfig.embeddingProvider}'`);
  }

  if (
    runtimeConfig.embeddingDimension &&
    embedding.length > 0 &&
    embedding.length !== runtimeConfig.embeddingDimension
  ) {
    throw new Error(
      `Embedding dimension mismatch: expected ${runtimeConfig.embeddingDimension}, received ${embedding.length}`,
    );
  }

  return embedding;
}

async function getEmbeddingRuntimeConfig(): Promise<ModelCallerConfig> {
  const config = await loadEmbeddingConfig();
  return {
    ...getDefaultConfig(),
    ollamaUrl: config.endpointOverride ?? getProviderEndpoint("ollama") ?? "http://localhost:11434",
    embeddingProvider: config.provider,
    embeddingModel: config.modelName,
    embeddingDimension: config.dimension,
    endpointOverride: config.endpointOverride,
    apiKey: config.apiKey,
  };
}

async function embedWithOllama(
  text: string,
  config: ModelCallerConfig,
  fetchFn: typeof fetch,
): Promise<number[]> {
  const response = await fetchFn(`${config.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await parseEmbeddingJson<{ embeddings?: unknown[][] }>(response, "Ollama");
  return validateEmbeddingVector(data.embeddings?.[0], "Ollama");
}

async function embedWithOpenAiCompatible(
  text: string,
  config: ModelCallerConfig,
  fetchFn: typeof fetch,
  options: {
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
  },
): Promise<number[]> {
  const apiKey = requireApiKey(config, options.name);
  const response = await fetchFn(`${options.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.extraHeaders,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
      ...(config.embeddingDimension ? { dimensions: config.embeddingDimension } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${options.name} embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await parseEmbeddingJson<{ data?: Array<{ embedding?: unknown }> }>(response, options.name);
  return validateEmbeddingVector(data.data?.[0]?.embedding, options.name);
}

async function embedWithVoyage(
  text: string,
  config: ModelCallerConfig,
  fetchFn: typeof fetch,
): Promise<number[]> {
  const apiKey = requireApiKey(config, "Voyage");
  const response = await fetchFn(
    `${config.endpointOverride ?? "https://api.voyageai.com"}/v1/embeddings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: [text],
        input_type: "document",
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Voyage embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await parseEmbeddingJson<{ data?: Array<{ embedding?: unknown }> }>(response, "Voyage");
  return validateEmbeddingVector(data.data?.[0]?.embedding, "Voyage");
}

async function embedWithCohere(
  text: string,
  config: ModelCallerConfig,
  fetchFn: typeof fetch,
): Promise<number[]> {
  const apiKey = requireApiKey(config, "Cohere");
  const response = await fetchFn(
    `${config.endpointOverride ?? "https://api.cohere.com"}/v2/embed`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        texts: [text],
        input_type: "search_document",
        embedding_types: ["float"],
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Cohere embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await parseEmbeddingJson<{ embeddings?: { float?: unknown[][] } }>(response, "Cohere");
  return validateEmbeddingVector(data.embeddings?.float?.[0], "Cohere");
}

async function embedWithMistral(
  text: string,
  config: ModelCallerConfig,
  fetchFn: typeof fetch,
): Promise<number[]> {
  const apiKey = requireApiKey(config, "Mistral");
  const response = await fetchFn(
    `${config.endpointOverride ?? "https://api.mistral.ai"}/v1/embeddings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text,
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Mistral embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await parseEmbeddingJson<{ data?: Array<{ embedding?: unknown }> }>(response, "Mistral");
  return validateEmbeddingVector(data.data?.[0]?.embedding, "Mistral");
}

async function embedWithGoogle(
  text: string,
  config: ModelCallerConfig,
  fetchFn: typeof fetch,
): Promise<number[]> {
  const apiKey = requireApiKey(config, "Google");
  const baseUrl = config.endpointOverride ?? "https://generativelanguage.googleapis.com/v1beta";
  const response = await fetchFn(
    `${baseUrl}/models/${config.embeddingModel}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
        ...(config.embeddingDimension ? { outputDimensionality: config.embeddingDimension } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Google embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await parseEmbeddingJson<{ embedding?: { values?: unknown } }>(response, "Google");
  return validateEmbeddingVector(data.embedding?.values, "Google");
}

async function embedWithHuggingFace(
  text: string,
  config: ModelCallerConfig,
  fetchFn: typeof fetch,
): Promise<number[]> {
  const baseUrl = config.endpointOverride
    ?? `https://api-inference.huggingface.co/pipeline/feature-extraction/${config.embeddingModel}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetchFn(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`HuggingFace embedding failed: ${response.status} ${response.statusText}`);
  }
  const data = await parseEmbeddingJson<unknown>(response, "HuggingFace");
  return validateEmbeddingVector(normalizeHuggingFaceEmbedding(data), "HuggingFace");
}

function normalizeHuggingFaceEmbedding(data: unknown): unknown {
  if (Array.isArray(data) && typeof data[0] === "number") {
    return data as number[];
  }
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const firstRow = data[0];
    if (firstRow.length > 0 && typeof firstRow[0] === "number") {
      return firstRow as number[];
    }
  }
  return [];
}

async function parseEmbeddingJson<T>(response: Response, providerName: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new RetryableEmbeddingError(`${providerName} returned empty or malformed embedding response`);
  }
}

function validateEmbeddingVector(value: unknown, providerName: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RetryableEmbeddingError(`${providerName} returned empty or malformed embedding response`);
  }
  if (value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new RetryableEmbeddingError(`${providerName} returned empty or malformed embedding response`);
  }
  return value as number[];
}

function requireApiKey(config: ModelCallerConfig, providerName: string): string {
  if (!config.apiKey) {
    throw new Error(`${providerName} embedding credential is not configured`);
  }
  return config.apiKey;
}
