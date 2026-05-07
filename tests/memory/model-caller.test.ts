import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  callGenerationModel,
  callEmbeddingModel,
  RetryableEmbeddingError,
  type ModelCallerConfig,
} from "@/memory/model-caller";
import { resetEmbeddingConfigCache } from "@/memory/embedding-config";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
  resetEmbeddingConfigCache();
  delete process.env.OLLAMA_ENDPOINT;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
});

afterEach(() => {
  delete process.env.OLLAMA_ENDPOINT;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
  resetEmbeddingConfigCache();
  vi.unstubAllGlobals();
});

describe("callGenerationModel", () => {
  it("builds correct request to Ollama generate endpoint", async () => {
    const fetched: { url: string; body: unknown }[] = [];
    const mockFetch = vi.fn(async (url: string, opts: RequestInit) => {
      fetched.push({ url, body: JSON.parse(opts.body as string) });
      return new Response(JSON.stringify({ response: "extracted facts here" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const config: ModelCallerConfig = {
      ollamaUrl: "http://gpu-machine:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };

    const result = await callGenerationModel("Extract facts from this", config);
    expect(result).toBe("extracted facts here");
    expect(fetched[0].url).toBe("http://gpu-machine:11434/api/generate");
    expect(fetched[0].body).toEqual({
      model: "mistral",
      prompt: "Extract facts from this",
      stream: false,
    });
  });

  it("throws on non-200 response", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("Internal Server Error", { status: 500 })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };
    await expect(callGenerationModel("test", config)).rejects.toThrow("Ollama generation failed");
  });
});

describe("callEmbeddingModel", () => {
  it("builds correct request to Ollama embed endpoint", async () => {
    const fetched: { url: string; body: unknown }[] = [];
    const mockFetch = vi.fn(async (url: string, opts: RequestInit) => {
      fetched.push({ url, body: JSON.parse(opts.body as string) });
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const config: ModelCallerConfig = {
      ollamaUrl: "http://gpu-machine:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };

    const result = await callEmbeddingModel("some text to embed", config);
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetched[0].url).toBe("http://gpu-machine:11434/api/embed");
    expect(fetched[0].body).toEqual({
      model: "all-minilm",
      input: "some text to embed",
    });
  });

  it("throws on non-200 response", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("Not Found", { status: 404 })
    );
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };
    await expect(callEmbeddingModel("test", config)).rejects.toThrow("Ollama embedding failed");
  });

  it("loads the embedding runtime config from the database when no config is passed", async () => {
    await sql`
      INSERT INTO embedding_config (
        provider,
        model_name,
        dimension,
        endpoint_override,
        status,
        updated_by
      )
      VALUES (
        'ollama',
        'nomic-embed-text',
        768,
        'http://db-config:11434',
        'ready',
        'test@local'
      )
    `;

    const fetched: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      fetched.push({ url, body: JSON.parse(String(opts.body)) });
      return new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.1)] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const result = await callEmbeddingModel("db-config text");
    expect(result).toHaveLength(768);
    expect(result[0]).toBe(0.1);
    expect(fetched[0].url).toBe("http://db-config:11434/api/embed");
    expect(fetched[0].body).toEqual({
      model: "nomic-embed-text",
      input: "db-config text",
    });
  });

  it("falls back to the old Ollama env/default path when no config row exists", async () => {
    process.env.OLLAMA_ENDPOINT = "http://fallback-host:11434";
    process.env.OLLAMA_EMBEDDING_MODEL = "all-minilm";

    const fetched: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      fetched.push({ url, body: JSON.parse(String(opts.body)) });
      return new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.4)] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const result = await callEmbeddingModel("fallback text");
    expect(result).toHaveLength(768);
    expect(result[0]).toBe(0.4);
    expect(fetched[0].url).toBe("http://fallback-host:11434/api/embed");
    expect(fetched[0].body).toEqual({
      model: "all-minilm",
      input: "fallback text",
    });
  });

  it("rejects empty OpenRouter embeddings as retryable malformed responses", async () => {
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "openai/text-embedding-3-small",
      embeddingProvider: "openrouter",
      embeddingDimension: 1536,
      endpointOverride: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      fetchFn: vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ embedding: [] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    };

    await expect(callEmbeddingModel("test", config)).rejects.toBeInstanceOf(RetryableEmbeddingError);
    await expect(callEmbeddingModel("test", config)).rejects.toThrow(
      "OpenRouter returned empty or malformed embedding response",
    );
  });

  it("rejects non-numeric OpenRouter embeddings before updating rows", async () => {
    const config: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "openai/text-embedding-3-small",
      embeddingProvider: "openrouter",
      embeddingDimension: 1536,
      endpointOverride: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      fetchFn: vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, "bad", 0.3] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    };

    await expect(callEmbeddingModel("test", config)).rejects.toBeInstanceOf(RetryableEmbeddingError);
    await expect(callEmbeddingModel("test", config)).rejects.toThrow(
      "OpenRouter returned empty or malformed embedding response",
    );
  });
});
