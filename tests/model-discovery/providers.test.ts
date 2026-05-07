import { describe, expect, it } from "vitest";
import {
  discoverAnthropicModels,
  discoverGeminiModels,
  discoverModelsForAdapter,
  discoverOllamaModels,
  discoverOpenAiModels,
} from "../../src/model-discovery/providers";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function fakeFetch(response: unknown, options: { status?: number; statusText?: string } = {}) {
  const calls: FetchCall[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      status: options.status ?? 200,
      statusText: options.statusText ?? "OK",
      json: async () => response,
      text: async () => String(response),
    } as Response;
  };

  return { calls, fetchFn };
}

describe("provider model discovery adapters", () => {
  it("discovers OpenAI models from the public docs catalog", async () => {
    const { calls, fetchFn } = fakeFetch(`
      <main>
        <a href="/api/docs/models/gpt-5.6">gpt-5.6</a>
        <span>text-embedding-3-large</span>
        <img src="/models/gpt-5.6.png" />
      </main>
    `);

    const models = await discoverOpenAiModels({ apiKey: "openai-key", fetch: fetchFn });

    expect(calls).toEqual([{
      url: "https://developers.openai.com/api/docs/models/all/",
      init: expect.objectContaining({
        method: "GET",
      }),
    }]);
    expect(models).toEqual([
      {
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.6",
        displayName: "gpt-5.6",
        family: "gpt",
        capabilities: ["text", "code", "reasoning"],
        local: false,
        metadataSourceName: "OpenAI public model docs",
        metadataSourceUrl: "https://developers.openai.com/api/docs/models/all/",
      },
    ]);
  });

  it("skips OpenAI models that are not usable by the Codex adapter", async () => {
    const { fetchFn } = fakeFetch(`
      gpt-5.6 tts-1 text-embedding-3-large whisper-1 dall-e-3 sora-2
      gpt-realtime computer-use-preview gpt-5.6.png chatgpt chatgpt-ui chatgpt-image-latest gpt-5-4
      gpt gpt-3 gpt-3.5-turbo gpt-4 gpt-4-turbo gpt-4.5 chatgpt-4o chatgpt-4o-latest
    `);

    const models = await discoverOpenAiModels({ apiKey: "openai-key", fetch: fetchFn });

    expect(models.map((model) => model.modelId)).toEqual([
      "chatgpt-4o-latest",
      "openai-codex/gpt-5.6",
    ]);
  });

  it("discovers Gemini models from the public docs catalog", async () => {
    const { calls, fetchFn } = fakeFetch(`
      <td><code>gemini-2.5-flash</code></td>
      <td>Gemini 2.5 Flash</td>
      <td><code>imagen-4.0-generate-preview</code></td>
    `);

    const models = await discoverGeminiModels({ apiKey: "gemini-key", fetch: fetchFn });

    expect(calls[0]).toEqual({
      url: "https://ai.google.dev/gemini-api/docs/models",
      init: expect.objectContaining({ method: "GET" }),
    });
    expect(models).toEqual([
      {
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        family: "gemini",
        capabilities: ["text", "code"],
        local: false,
        metadataSourceName: "Gemini public model docs",
        metadataSourceUrl: "https://ai.google.dev/gemini-api/docs/models",
      },
    ]);
  });

  it("infers Gemini reasoning models from public docs names", async () => {
    const { fetchFn } = fakeFetch(`
      gemini-2.5-pro
      gemini-tokenizer
      gemini-2.5-flash-lite
    `);

    const models = await discoverGeminiModels({ apiKey: "gemini-key", fetch: fetchFn });

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: "google/gemini-2.5-pro",
        capabilities: ["text", "code", "reasoning"],
      }),
      expect.objectContaining({
        modelId: "google/gemini-2.5-flash-lite",
        capabilities: ["text", "code"],
      }),
    ]));
  });

  it("discovers Anthropic models from the public docs catalog", async () => {
    const { calls, fetchFn } = fakeFetch(`
      <td>Claude Sonnet 4.7</td><td><code>claude-sonnet-4-7</code></td>
      <td>Claude 3 Opus</td><td><code>claude-3-opus-20240229</code></td>
      <td>Bedrock</td><td><code>claude-sonnet-4-7-v1</code></td>
    `);

    const models = await discoverAnthropicModels({ apiKey: "anthropic-key", fetch: fetchFn });

    expect(calls).toEqual([{
      url: "https://docs.anthropic.com/en/docs/models-overview",
      init: expect.objectContaining({
        method: "GET",
      }),
    }]);
    expect(models).toEqual(expect.arrayContaining([
      {
        provider: "anthropic",
        adapterType: "claude-code",
        modelId: "anthropic/claude-sonnet-4-7",
        displayName: "Claude Sonnet 4 7",
        family: "claude",
        capabilities: ["text", "code", "reasoning"],
        local: false,
        metadataSourceName: "Anthropic public model docs",
        metadataSourceUrl: "https://docs.anthropic.com/en/docs/models-overview",
      },
      {
        provider: "anthropic",
        adapterType: "claude-code",
        modelId: "anthropic/claude-3-opus-20240229",
        displayName: "Claude 3 Opus 20240229",
        family: "claude",
        capabilities: ["text", "code", "reasoning"],
        local: false,
        metadataSourceName: "Anthropic public model docs",
        metadataSourceUrl: "https://docs.anthropic.com/en/docs/models-overview",
      },
    ]));
  });

  it("discovers Ollama models from the local runtime", async () => {
    const { calls, fetchFn } = fakeFetch({
      models: [
        {
          name: "qwen3.6:35b",
          details: { family: "qwen3" },
        },
        {
          model: "llava:latest",
          details: { family: "llava" },
        },
      ],
    });

    const models = await discoverOllamaModels({
      baseUrl: "http://127.0.0.1:11434",
      fetch: fetchFn,
    });

    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:11434/api/tags",
      init: expect.objectContaining({ method: "GET" }),
    });
    expect(models).toEqual([
      {
        provider: "local",
        adapterType: "ollama",
        modelId: "qwen3.6:35b",
        displayName: "qwen3.6:35b",
        family: "qwen3",
        capabilities: ["text", "code"],
        local: true,
        metadataSourceName: "Ollama Tags API",
        metadataSourceUrl: "http://127.0.0.1:11434/api/tags",
      },
      {
        provider: "local",
        adapterType: "ollama",
        modelId: "llava:latest",
        displayName: "llava:latest",
        family: "llava",
        capabilities: ["text", "code"],
        local: true,
        metadataSourceName: "Ollama Tags API",
        metadataSourceUrl: "http://127.0.0.1:11434/api/tags",
      },
    ]);
  });

  it("uses the runtime Ollama endpoint convention when no stored base URL is provided", async () => {
    const originalFetch = globalThis.fetch;
    const originalEndpoint = process.env.OLLAMA_ENDPOINT;
    const originalBaseUrl = process.env.OLLAMA_BASE_URL;
    const { calls, fetchFn } = fakeFetch({
      models: [{ name: "qwen3:32b", details: { family: "qwen3" } }],
    });
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;
    process.env.OLLAMA_ENDPOINT = "http://runtime-ollama.test:11434";
    delete process.env.OLLAMA_BASE_URL;

    try {
      const models = await discoverModelsForAdapter({
        adapterType: "ollama",
        credentials: {},
      });

      expect(calls[0]?.url).toBe("http://runtime-ollama.test:11434/api/tags");
      expect(models.map((model) => model.modelId)).toEqual(["qwen3:32b"]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEndpoint === undefined) {
        delete process.env.OLLAMA_ENDPOINT;
      } else {
        process.env.OLLAMA_ENDPOINT = originalEndpoint;
      }
      if (originalBaseUrl === undefined) {
        delete process.env.OLLAMA_BASE_URL;
      } else {
        process.env.OLLAMA_BASE_URL = originalBaseUrl;
      }
    }
  });

  it("supports Gemini public docs discovery without an API key", async () => {
    const { calls, fetchFn } = fakeFetch("gemini-pro");

    await discoverGeminiModels({ apiKey: "", fetch: fetchFn });

    expect(calls[0]?.url).toBe("https://ai.google.dev/gemini-api/docs/models");
  });

  it("does not send runtime environment credentials for public OpenAI discovery", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    const { calls, fetchFn } = fakeFetch("gpt-5.6");
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;
    process.env.OPENAI_API_KEY = "runtime-openai-key";

    try {
      const models = await discoverModelsForAdapter({ adapterType: "codex" });

      expect(calls[0]).toEqual({
        url: "https://developers.openai.com/api/docs/models/all/",
        init: expect.objectContaining({
          method: "GET",
        }),
      });
      expect(models.map((model) => model.modelId)).toEqual(["openai-codex/gpt-5.6"]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("falls back to static Gemini model names when public docs include no usable ids", async () => {
    const { fetchFn } = fakeFetch("gemini-api-card gemini-api-model-table gemini-embedding-001 gemini-2-5-flash gemini-2-0-flash-deprecated");

    const models = await discoverGeminiModels({ fetch: fetchFn });

    expect(models.map((model) => model.modelId)).toContain("google/gemini-2.5-flash");
    expect(models[0]?.metadataSourceName).toBe("Gemini static model fallback");
  });

  it("falls back to static OpenAI model names when public docs fetch fails", async () => {
    const { fetchFn } = fakeFetch({ error: "denied" }, { status: 401, statusText: "Unauthorized" });

    const models = await discoverOpenAiModels({ fetch: fetchFn });

    expect(models.map((model) => model.modelId)).toContain("openai-codex/gpt-5");
    expect(models[0]?.metadataSourceName).toBe("OpenAI static model fallback");
  });
});
