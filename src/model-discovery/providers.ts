import { canonicalModelIdForAdapter } from "@/model-health/model-identity";
import { getProviderEndpoint } from "@/adapters/provider-config";
import type { DiscoveredModel } from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ProviderDiscoveryOptions {
  apiKey?: string | null;
  fetch?: FetchLike;
}

interface OllamaDiscoveryOptions {
  baseUrl?: string | null;
  fetch?: FetchLike;
}

interface AdapterDiscoveryOptions {
  adapterType: string;
  provider?: string | null;
  credentials?: Record<string, string | undefined>;
}

interface AdapterDiscoveryConfig {
  adapterType: string;
  provider: string;
  source: string;
  discover: () => Promise<DiscoveredModel[]>;
}

interface OllamaModel {
  name?: unknown;
  model?: unknown;
  details?: {
    family?: unknown;
  };
}

const OPENAI_PUBLIC_MODELS_URL = "https://developers.openai.com/api/docs/models/all/";
const GEMINI_PUBLIC_MODELS_URL = "https://ai.google.dev/gemini-api/docs/models";
const ANTHROPIC_PUBLIC_MODELS_URL = "https://docs.anthropic.com/en/docs/models-overview";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const STATIC_OPENAI_MODELS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o4-mini",
  "o3",
];
const STATIC_GEMINI_MODELS = [
  "gemini-3.1-pro",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];
const STATIC_ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-4",
];

export class UnsupportedDiscoveryAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDiscoveryAdapterError";
  }
}

export async function discoverModelsForAdapter(
  options: AdapterDiscoveryOptions,
): Promise<DiscoveredModel[]> {
  const config = discoveryConfigForAdapter(options);
  return config.discover();
}

export function discoveryConfigForAdapter(
  options: AdapterDiscoveryOptions,
): AdapterDiscoveryConfig {
  const adapterType = options.adapterType.trim();
  const provider = options.provider?.trim().toLowerCase() || null;

  if (adapterType === "codex") {
    assertDiscoveryProvider(adapterType, provider, "openai");
    return {
      adapterType,
      provider: "openai",
      source: "openai_public_model_docs",
      discover: () => discoverOpenAiModels({}),
    };
  }

  if (adapterType === "gemini") {
    assertDiscoveryProvider(adapterType, provider, "google");
    return {
      adapterType,
      provider: "google",
      source: "gemini_public_model_docs",
      discover: () => discoverGeminiModels({}),
    };
  }

  if (adapterType === "claude-code") {
    assertDiscoveryProvider(adapterType, provider, "anthropic");
    return {
      adapterType,
      provider: "anthropic",
      source: "anthropic_public_model_docs",
      discover: () => discoverAnthropicModels({}),
    };
  }

  if (adapterType === "ollama") {
    assertDiscoveryProvider(adapterType, provider, "local");
    const baseUrl = credentialValue(
      options.credentials,
      "OLLAMA_ENDPOINT",
      "OLLAMA_BASE_URL",
    );
    return {
      adapterType,
      provider: "local",
      source: "ollama_tags_api",
      discover: () => discoverOllamaModels(baseUrl === undefined ? {} : { baseUrl }),
    };
  }

  throw new UnsupportedDiscoveryAdapterError(
    `unsupported model discovery adapter type: ${adapterType}`,
  );
}

export async function discoverOpenAiModels(
  options: ProviderDiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const discovery = await discoverPublicModelIds({
    fetch: options.fetch,
    url: OPENAI_PUBLIC_MODELS_URL,
    sourceName: "OpenAI public model docs",
    fallbackSourceName: "OpenAI static model fallback",
    fallbackIds: STATIC_OPENAI_MODELS,
    extractIds: extractOpenAiModelIds,
  });

  return discovery.ids
    .map((id) => discoveredOpenAiModel(id, discovery.sourceName, discovery.sourceUrl))
    .filter((model): model is DiscoveredModel => model !== null);
}

export async function discoverGeminiModels(
  options: ProviderDiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const discovery = await discoverPublicModelIds({
    fetch: options.fetch,
    url: GEMINI_PUBLIC_MODELS_URL,
    sourceName: "Gemini public model docs",
    fallbackSourceName: "Gemini static model fallback",
    fallbackIds: STATIC_GEMINI_MODELS,
    extractIds: extractGeminiModelIds,
  });

  return discovery.ids
    .map((id) => discoveredGeminiModel(id, discovery.sourceName, discovery.sourceUrl))
    .filter((model): model is DiscoveredModel => model !== null);
}

export async function discoverAnthropicModels(
  options: ProviderDiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const discovery = await discoverPublicModelIds({
    fetch: options.fetch,
    url: ANTHROPIC_PUBLIC_MODELS_URL,
    sourceName: "Anthropic public model docs",
    fallbackSourceName: "Anthropic static model fallback",
    fallbackIds: STATIC_ANTHROPIC_MODELS,
    extractIds: extractAnthropicModelIds,
  });

  return discovery.ids.map((id) => discoveredAnthropicModel(id, discovery.sourceName, discovery.sourceUrl));
}

export async function discoverOllamaModels(
  options: OllamaDiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const baseUrl = trimTrailingSlash(
    firstPresent(
      options.baseUrl,
      process.env.OLLAMA_ENDPOINT,
      process.env.OLLAMA_BASE_URL,
      getProviderEndpoint("ollama"),
    ) ?? DEFAULT_OLLAMA_BASE_URL,
  );
  const url = `${baseUrl}/api/tags`;
  const body = await fetchJson(url, {
    fetch: options.fetch,
    init: { method: "GET" },
    sourceName: "Ollama Tags API",
  });
  const models = arrayFromProperty<OllamaModel>(body, "models");

  return models
    .map((model) => {
      const id = stringValue(model.name) ?? stringValue(model.model);
      if (!id) return null;
      return discoveredModel({
        provider: "local",
        adapterType: "ollama",
        modelId: id,
        displayName: id,
        family: stringValue(model.details?.family) ?? inferFamily(id),
        capabilities: inferCapabilities(id),
        local: true,
        metadataSourceName: "Ollama Tags API",
        metadataSourceUrl: url,
      });
    })
    .filter((model): model is DiscoveredModel => model !== null);
}

async function fetchJson(
  url: string,
  options: {
    fetch?: FetchLike;
    init: RequestInit;
    sourceName: string;
  },
): Promise<unknown> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error(`${options.sourceName} discovery requires fetch`);

  const response = await fetchFn(url, options.init);
  if (!response.ok) {
    throw new Error(`${options.sourceName} request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<unknown>;
}

async function fetchText(
  url: string,
  options: {
    fetch?: FetchLike;
    sourceName: string;
  },
): Promise<string> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error(`${options.sourceName} discovery requires fetch`);

  const response = await fetchFn(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`${options.sourceName} request failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function discoverPublicModelIds(input: {
  fetch?: FetchLike;
  url: string;
  sourceName: string;
  fallbackSourceName: string;
  fallbackIds: string[];
  extractIds: (text: string) => string[];
}): Promise<{ ids: string[]; sourceName: string; sourceUrl: string | null }> {
  try {
    const text = await fetchText(input.url, {
      fetch: input.fetch,
      sourceName: input.sourceName,
    });
    const ids = input.extractIds(text);
    if (ids.length > 0) {
      return { ids, sourceName: input.sourceName, sourceUrl: input.url };
    }
  } catch {
    // Use the static catalog below when public documentation is temporarily unavailable.
  }

  return { ids: input.fallbackIds, sourceName: input.fallbackSourceName, sourceUrl: null };
}

function extractOpenAiModelIds(text: string): string[] {
  return uniqueMatches(text, /\b(?:gpt|chatgpt|o[1-9])[-.a-z0-9]*\b/gi)
    .filter((id) => !/\.(?:png|jpg|jpeg|svg|webp)$/i.test(id))
    .filter((id) => id !== "chatgpt")
    .filter((id) => !id.startsWith("chatgpt-") || id === "chatgpt-4o-latest")
    .filter((id) => !/^gpt$/.test(id))
    .filter((id) => !/^gpt-3(?:\.5)?(?:-turbo)?$/.test(id))
    .filter((id) => !/^gpt-4(?:-turbo(?:-preview)?|\.5(?:-preview)?)?$/.test(id))
    .filter((id) => !/(?:image|ui)/.test(id))
    .filter((id) => !/^gpt-\d-\d$/.test(id))
    .filter((id) => inferOpenAiCapabilities(id).length > 0);
}

function extractGeminiModelIds(text: string): string[] {
  return uniqueMatches(text, /\bgemini-[a-z0-9][-.a-z0-9]*\b/gi)
    .filter((id) => /^gemini-\d/.test(id))
    .filter((id) => !id.includes("deprecated"))
    .filter((id) => !/^gemini-\d-\d/.test(id))
    .filter((id) => inferGeminiCapabilities(id).length > 0);
}

function extractAnthropicModelIds(text: string): string[] {
  return uniqueMatches(text, /\bclaude-[a-z0-9][-.a-z0-9]*\b/gi)
    .filter((id) => /^claude-(?:(?:\d+-)?(?:opus|sonnet|haiku)|(?:opus|sonnet|haiku))-/.test(id))
    .filter((id) => !/-v\d+$/.test(id));
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    ids.add(match[0].toLowerCase());
  }
  return [...ids].sort();
}

function discoveredOpenAiModel(
  id: string,
  metadataSourceName: string,
  metadataSourceUrl: string | null,
): DiscoveredModel | null {
  const capabilities = inferOpenAiCapabilities(id);
  if (capabilities.length === 0) return null;
  return discoveredModel({
    provider: "openai",
    adapterType: "codex",
    modelId: canonicalModelIdForAdapter("codex", id),
    displayName: id,
    family: inferFamily(id),
    capabilities,
    local: false,
    metadataSourceName,
    metadataSourceUrl,
  });
}

function discoveredGeminiModel(
  id: string,
  metadataSourceName: string,
  metadataSourceUrl: string | null,
): DiscoveredModel | null {
  const capabilities = inferGeminiCapabilities(id);
  if (capabilities.length === 0) return null;
  return discoveredModel({
    provider: "google",
    adapterType: "gemini",
    modelId: canonicalModelIdForAdapter("gemini", id),
    displayName: displayNameFromModelId(id),
    family: inferFamily(id),
    capabilities,
    local: false,
    metadataSourceName,
    metadataSourceUrl,
  });
}

function discoveredAnthropicModel(
  id: string,
  metadataSourceName: string,
  metadataSourceUrl: string | null,
): DiscoveredModel {
  return discoveredModel({
    provider: "anthropic",
    adapterType: "claude-code",
    modelId: canonicalModelIdForAdapter("claude-code", id),
    displayName: displayNameFromModelId(id),
    family: inferFamily(id),
    capabilities: inferCapabilities(id),
    local: false,
    metadataSourceName,
    metadataSourceUrl,
  });
}

function discoveredModel(model: DiscoveredModel): DiscoveredModel {
  return {
    ...model,
    family: model.family?.trim() || null,
  };
}

function inferCapabilities(modelId: string): string[] {
  const lower = modelId.toLowerCase();
  if (lower.includes("embedding")) return ["embedding"];
  if (lower.includes("image") || lower.includes("imagen")) return ["image"];
  if (lower.includes("moderation") || lower.includes("safety")) return ["moderation"];

  const capabilities = ["text", "code"];
  if (/\b(gpt|claude|pro|opus|sonnet|thinking|reasoning)\b/.test(lower.replace(/[-_:./]/g, " "))) {
    capabilities.push("reasoning");
  }
  return capabilities;
}

function inferOpenAiCapabilities(modelId: string): string[] {
  const lower = modelId.toLowerCase();
  const normalized = lower.replace(/[-_:./]/g, " ");

  if (
    lower.includes("embedding") ||
    lower.includes("moderation") ||
    lower.includes("safety") ||
    /\b(tts|whisper|dall|dalle|sora|realtime|audio|transcribe|speech|computer use)\b/.test(normalized)
  ) {
    return [];
  }

  const capabilities = ["text", "code"];
  if (/\b(gpt|chatgpt|codex|o[1-9])\b/.test(normalized)) {
    capabilities.push("reasoning");
    return capabilities;
  }

  return [];
}

function inferGeminiCapabilities(modelId: string): string[] {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("imagen") ||
    lower.includes("image") ||
    lower.includes("veo") ||
    lower.includes("audio") ||
    lower.includes("tts") ||
    lower.includes("live") ||
    lower.includes("computer-use") ||
    lower.includes("tokenizer") ||
    lower.includes("api")
  ) {
    return [];
  }

  const capabilities = ["text", "code"];
  if (lower.includes("embedding-generation")) {
    capabilities.push("embedding");
  }
  if (/\b(?:pro|thinking|reasoning)\b/.test(lower.replace(/[-_:./]/g, " "))) {
    capabilities.push("reasoning");
  }
  return capabilities;
}

function inferFamily(modelId: string): string | null {
  const id = stripPrefix(modelId, "models/");
  const first = id.split(/[.:_-]/)[0]?.trim();
  return first || null;
}

function arrayFromProperty<T>(value: unknown, property: string): T[] {
  if (!isRecord(value)) return [];
  const items = value[property];
  return Array.isArray(items) ? items as T[] : [];
}

function firstPresent(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function displayNameFromModelId(modelId: string): string {
  return modelId
    .split(/[-_:/]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertDiscoveryProvider(
  adapterType: string,
  requestedProvider: string | null,
  supportedProvider: string,
) {
  if (!requestedProvider || requestedProvider === supportedProvider) return;
  throw new UnsupportedDiscoveryAdapterError(
    `unsupported model discovery provider for ${adapterType}: ${requestedProvider}`,
  );
}

function credentialValue(
  credentials: Record<string, string | undefined> | undefined,
  ...keys: string[]
): string | undefined {
  if (!credentials) return undefined;
  for (const key of keys) {
    if (hasOwn(credentials, key)) return credentials[key];
  }
  return undefined;
}
