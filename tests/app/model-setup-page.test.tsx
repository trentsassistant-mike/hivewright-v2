// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelSetupPage from "../../src/app/(dashboard)/setup/models/page";

const selectedHive = {
  id: "hive-1",
  slug: "hive-1",
  name: "Hive One",
  type: "digital",
};

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    hives: [selectedHive],
    selected: selectedHive,
    selectHive: vi.fn(),
    loading: false,
  }),
}));

describe("ModelSetupPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("previews auto routing for sample task context", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/model-setup")) {
        return jsonResponse({
          data: {
            models: [],
            credentials: [],
          },
        });
      }
      if (url.includes("/api/model-routing") && url.includes("previewTitle=")) {
        return jsonResponse({
          data: {
            previewRoute: {
              adapterType: "codex",
              model: "openai-codex/gpt-5.5",
              profile: "coding",
              explanation: "Selected openai-codex/gpt-5.5 using coding profile.",
              scoreBreakdown: {
                selectedScore: 72.5,
                candidates: [
                  {
                    model: "openai-codex/gpt-5.5",
                    adapterType: "codex",
                    score: 72.5,
                    capabilityFit: 81.2,
                    costScore: 25,
                    speedScore: 70,
                    selected: true,
                    missingAxes: [],
                    lowConfidenceAxes: [],
                  },
                ],
              },
            },
          },
        });
      }
      if (url.includes("/api/model-routing")) {
        return jsonResponse({
          data: {
            policy: {
              preferences: { costQualityBalance: 50 },
              routeOverrides: {},
              roleRoutes: {},
            },
            models: [],
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<ModelSetupPage />);

    await screen.findByText("Routing Policy");
    fireEvent.change(screen.getByLabelText("Preview title"), {
      target: { value: "Fix TypeScript route tests" },
    });
    fireEvent.change(screen.getByLabelText("Preview brief"), {
      target: { value: "Write code and Vitest coverage for the route handler." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview route" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("previewTitle=Fix+TypeScript+route+tests"));
    });
    expect(await screen.findByText("coding")).toBeTruthy();
    expect(screen.getAllByText("openai-codex/gpt-5.5").length).toBeGreaterThan(0);
    expect(screen.getByText("Selected openai-codex/gpt-5.5 using coding profile.")).toBeTruthy();
    expect(screen.getAllByText("72.50").length).toBeGreaterThan(0);
  });

  it("shows a single routing priority slider and saves costQualityBalance", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/model-setup")) {
        return jsonResponse({ data: { models: [], credentials: [] } });
      }
      if (url.includes("/api/model-routing") && init?.method === "PATCH") {
        return jsonResponse({
          data: {
            policy: {
              preferences: { costQualityBalance: JSON.parse(String(init.body)).policy.preferences.costQualityBalance },
              routeOverrides: {},
              roleRoutes: {},
            },
            models: [],
          },
        });
      }
      if (url.includes("/api/model-routing")) {
        return jsonResponse({
          data: {
            policy: {
              preferences: { costQualityBalance: 50 },
              routeOverrides: {},
              roleRoutes: {},
            },
            models: [],
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<ModelSetupPage />);

    const slider = await screen.findByLabelText("Routing priority") as HTMLInputElement;
    expect(slider.getAttribute("type")).toBe("range");
    expect(slider.value).toBe("50");
    expect(screen.getAllByText("Cost").length).toBeGreaterThan(0);
    expect(screen.getByText("Balanced")).toBeTruthy();
    expect(screen.getAllByText("Quality").length).toBeGreaterThan(0);
    expect(screen.queryByText("Minimum quality")).toBeNull();
    expect(screen.queryByText("Quality weight")).toBeNull();
    expect(screen.queryByText("Cost weight")).toBeNull();
    expect(screen.queryByText("Local bonus")).toBeNull();

    fireEvent.change(slider, { target: { value: "72" } });
    fireEvent.click(screen.getByRole("button", { name: "Save routing policy" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/model-routing",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("\"costQualityBalance\":72"),
        }),
      );
    });
  });

  it("shows discovery labels and sends explicit enable-disable updates", async () => {
    const model = {
      modelCatalogId: "catalog-1",
      hiveModelId: "hive-model-1",
      routeKey: "google:gemini:google/gemini-new",
      provider: "google",
      adapterType: "gemini",
      modelId: "google/gemini-new",
      displayName: "Gemini New",
      family: "gemini",
      capabilities: ["text", "code"],
      local: false,
      hiveEnabled: false,
      ownerDisabledAt: "2026-05-04T01:00:00.000Z",
      ownerDisabledReason: "Disabled by owner in model setup",
      firstSeenAt: "2026-05-03T01:00:00.000Z",
      lastSeenAt: "2026-05-04T01:00:00.000Z",
      staleSince: null,
      deprecatedAt: null,
      discoverySource: "gemini_models_api",
      credentialId: null,
      credentialName: null,
      fallbackPriority: 100,
      costPerInputToken: null,
      costPerOutputToken: null,
      benchmarkQualityScore: null,
      routingCostScore: null,
      metadataSourceName: "Gemini Models API",
      metadataSourceUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      metadataLastCheckedAt: "2026-05-04T01:00:00.000Z",
      status: "unknown",
      latencyMs: null,
      failureClass: null,
      failureMessage: null,
      lastProbedAt: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/model-setup") && init?.method === "PATCH") {
        return jsonResponse({
          data: {
            models: [{ ...model, hiveEnabled: JSON.parse(String(init.body)).enabled }],
          },
        });
      }
      if (url.includes("/api/model-setup")) {
        return jsonResponse({
          data: {
            models: [model],
            credentials: [],
          },
        });
      }
      if (url.includes("/api/model-routing")) {
        return jsonResponse({
          data: {
            policy: {
              preferences: { costQualityBalance: 50 },
              routeOverrides: {},
              roleRoutes: {},
            },
            models: [],
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<ModelSetupPage />);

    expect(await screen.findByText(/owner disabled/)).toBeTruthy();
    expect(screen.getByText("source gemini_models_api")).toBeTruthy();
    expect(screen.getByText(/first seen/)).toBeTruthy();
    expect(screen.getByText(/last seen/)).toBeTruthy();

    const usageCheckbox = screen.getByLabelText("Enable Gemini New") as HTMLInputElement;

    fireEvent.click(usageCheckbox);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/model-setup",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("\"enabled\":true"),
        }),
      );
    });
    await waitFor(() => expect(usageCheckbox.checked).toBe(true));

    fireEvent.click(usageCheckbox);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/model-setup",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("\"enabled\":false"),
        }),
      );
    });
  });

  it("shows detailed benchmark data for each model", async () => {
    const model = {
      modelCatalogId: "catalog-1",
      hiveModelId: "hive-model-1",
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      hiveEnabled: true,
      ownerDisabledAt: null,
      ownerDisabledReason: null,
      firstSeenAt: null,
      lastSeenAt: null,
      staleSince: null,
      deprecatedAt: null,
      discoverySource: "openai_public_model_docs",
      credentialId: null,
      credentialName: null,
      fallbackPriority: 100,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      benchmarkQualityScore: 96,
      routingCostScore: 70,
      capabilityScores: [
        {
          modelCatalogId: "catalog-1",
          provider: "openai",
          adapterType: "codex",
          modelId: "openai-codex/gpt-5.5",
          canonicalModelId: "openai-codex/gpt-5.5",
          axis: "coding",
          score: 53.1,
          rawScore: "53.1",
          source: "LLM Stats",
          sourceUrl: "https://llm-stats.example/leaderboard",
          benchmarkName: "Coding",
          modelVersionMatched: "GPT-5.5",
          confidence: "high",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
        {
          modelCatalogId: "catalog-1",
          provider: "openai",
          adapterType: "codex",
          modelId: "openai-codex/gpt-5.5",
          canonicalModelId: "openai-codex/gpt-5.5",
          axis: "writing",
          score: 30.8,
          rawScore: "30.8",
          source: "LLM Stats",
          sourceUrl: "https://llm-stats.example/leaderboard",
          benchmarkName: "Writing",
          modelVersionMatched: "GPT-5.5",
          confidence: "medium",
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
      ],
      metadataSourceName: "OpenAI public model docs",
      metadataSourceUrl: "https://developers.openai.com/api/docs/models/all/",
      metadataLastCheckedAt: "2026-05-04T00:00:00.000Z",
      status: "healthy",
      latencyMs: 321,
      failureClass: null,
      failureMessage: null,
      lastProbedAt: "2026-05-04T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/model-setup")) {
        return jsonResponse({ data: { models: [model], credentials: [] } });
      }
      if (url.includes("/api/model-routing")) {
        return jsonResponse({
          data: {
            policy: {
              preferences: { costQualityBalance: 50 },
              routeOverrides: {},
              roleRoutes: {},
            },
            models: [],
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<ModelSetupPage />);

    expect(await screen.findByText("Benchmarks")).toBeTruthy();
    expect(screen.getAllByText("Coding").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Writing").length).toBeGreaterThan(0);
    expect(screen.getByText("53.10")).toBeTruthy();
    expect(screen.getByText("30.80")).toBeTruthy();
    expect(screen.getAllByText("LLM Stats").length).toBeGreaterThan(0);
    expect(screen.getByText("medium")).toBeTruthy();
  });

  it("runs health probes across the enabled model set", async () => {
    const models = Array.from({ length: 88 }, (_, index) => ({
      modelCatalogId: `catalog-${index}`,
      hiveModelId: `hive-model-${index}`,
      routeKey: `openai:codex:openai-codex/gpt-5.${index}`,
      provider: "openai",
      adapterType: "codex",
      modelId: `openai-codex/gpt-5.${index}`,
      displayName: `GPT 5.${index}`,
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      hiveEnabled: index < 83,
      ownerDisabledAt: null,
      ownerDisabledReason: null,
      firstSeenAt: null,
      lastSeenAt: null,
      staleSince: null,
      deprecatedAt: null,
      discoverySource: "openai_public_model_docs",
      credentialId: null,
      credentialName: null,
      fallbackPriority: index,
      costPerInputToken: null,
      costPerOutputToken: null,
      benchmarkQualityScore: null,
      routingCostScore: null,
      metadataSourceName: "OpenAI public model docs",
      metadataSourceUrl: "https://developers.openai.com/api/docs/models/all/",
      metadataLastCheckedAt: null,
      status: "unknown",
      latencyMs: null,
      failureClass: null,
      failureMessage: null,
      lastProbedAt: null,
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/model-health/probe")) {
        return jsonResponse({ data: { result: { considered: 83, probed: 83 } } });
      }
      if (url.includes("/api/model-setup")) {
        return jsonResponse({ data: { models, credentials: [] } });
      }
      if (url.includes("/api/model-routing")) {
        return jsonResponse({
          data: {
            policy: {
              preferences: { costQualityBalance: 50 },
              routeOverrides: {},
              roleRoutes: {},
            },
            models: [],
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<ModelSetupPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Run health probes" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/model-health/probe",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ hiveId: "hive-1", includeFresh: true, limit: 83 }),
        }),
      );
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
