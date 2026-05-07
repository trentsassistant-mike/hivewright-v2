// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbeddingsSettingsPage from "../../src/app/(dashboard)/settings/embeddings/page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("EmbeddingsSettingsPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps the selected target visible and disables save while re-embedding is active", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/embedding-config") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: {
            config: {
              id: "cfg-1",
              provider: "openrouter",
              modelName: "openai/text-embedding-3-small",
              dimension: 1536,
              apiCredentialKey: "OPENROUTER_API_KEY",
              endpointOverride: "https://openrouter.ai/api/v1",
              status: "reembedding",
              lastReembeddedId: null,
              reembedTotal: 120,
              reembedProcessed: 35,
              reembedStartedAt: "2026-04-22T08:01:00.000Z",
              reembedFinishedAt: null,
              lastError: null,
              updatedAt: "2026-04-22T08:01:00.000Z",
              updatedBy: "owner@local",
            },
            catalog: embeddingCatalog(),
            errorSummary: {
              count: 2,
              latestMessage: "Row 36 timed out",
            },
            recentErrors: [],
          },
        });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({
          data: [
            { id: "cred-1", key: "OPENROUTER_API_KEY", name: "OpenRouter" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<EmbeddingsSettingsPage />);

    const providerSelect = await screen.findByRole("combobox", { name: /Provider/i });
    const modelSelect = screen.getByRole("combobox", { name: /Model/i });
    expect((providerSelect as HTMLSelectElement).value).toBe("openrouter");
    expect((modelSelect as HTMLSelectElement).value).toBe("openai/text-embedding-3-small");
    expect(screen.getByDisplayValue("1536")).toBeTruthy();
    expect(screen.getByDisplayValue("https://openrouter.ai/api/v1")).toBeTruthy();
    expect(screen.getByText(/Re-embedding is currently running/i)).toBeTruthy();
    expect(screen.getByText(/Progress: 35 of 120/i)).toBeTruthy();
    expect(screen.getByText(/2 re-embed errors logged/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Re-embed running/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders terminal error state details after a run finishes with failures", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/embedding-config") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: {
            config: {
              id: "cfg-2",
              provider: "openrouter",
              modelName: "openai/text-embedding-3-small",
              dimension: 1536,
              apiCredentialKey: "OPENROUTER_API_KEY",
              endpointOverride: "https://openrouter.ai/api/v1",
              status: "error",
              lastReembeddedId: "mem-50",
              reembedTotal: 80,
              reembedProcessed: 80,
              reembedStartedAt: "2026-04-22T08:00:00.000Z",
              reembedFinishedAt: "2026-04-22T08:03:00.000Z",
              lastError: "1 chunk failed",
              updatedAt: "2026-04-22T08:03:00.000Z",
              updatedBy: "owner@local",
            },
            catalog: embeddingCatalog(),
            errorSummary: {
              count: 1,
              latestMessage: "Chunk 51 provider timeout",
            },
            recentErrors: [
              {
                id: "err-1",
                memoryEmbeddingId: "mem-51",
                sourceType: "note",
                sourceId: "note-51",
                chunkText: "problem row",
                errorMessage: "Chunk 51 provider timeout",
                attemptCount: 1,
                updatedAt: "2026-04-22T08:03:00.000Z",
              },
            ],
          },
        });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({
          data: [
            { id: "cred-1", key: "OPENROUTER_API_KEY", name: "OpenRouter" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<EmbeddingsSettingsPage />);

    await waitFor(() => expect(screen.getByText(/Status: error/i)).toBeTruthy());
    expect(screen.getByText(/Latest run: 80 of 80 processed. 1 failed./i)).toBeTruthy();
    expect(screen.getByText(/1 re-embed error logged. Latest: Chunk 51 provider timeout/i)).toBeTruthy();
    expect(screen.getByText(/Recent row failures/i)).toBeTruthy();
    expect(screen.getByText(/note \/ note-51/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save & re-embed/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function embeddingCatalog() {
  return [
    {
      provider: "ollama",
      label: "Ollama",
      models: [{ modelName: "nomic-embed-text", dimension: 768 }],
    },
    {
      provider: "openrouter",
      label: "OpenRouter",
      models: [{ modelName: "openai/text-embedding-3-small", dimension: 1536 }],
    },
  ];
}
