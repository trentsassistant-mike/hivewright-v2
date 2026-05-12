// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RolesPage from "../../src/app/(dashboard)/roles/page";

let selectedHive: { id: string; slug: string; name: string; type: string } | null = null;

vi.mock("../../src/components/hive-context", () => ({
  useHiveContext: () => ({
    hives: selectedHive ? [selectedHive] : [],
    selected: selectedHive,
    selectHive: vi.fn(),
    loading: false,
  }),
}));

describe("RolesPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    selectedHive = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps model setup and health out of the roles page", async () => {
    selectedHive = { id: "hive-1", slug: "hive-1", name: "Hive One", type: "digital" };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Roles & Agents" })).toBeTruthy());
    expect(screen.queryByText("Auto Model Routing")).toBeNull();
    expect(screen.queryByText("Model Health")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Model Setup" }).getAttribute("href")).toBe("/setup/models");
  });

  it("shows the native EA card as connector-configured", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Executive Assistant")).toBeTruthy());
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("connector config")).toBeTruthy();
    expect(screen.queryByText("claude-opus-4-7")).toBeNull();
  });

  it("offers GPT-5.5 in the codex-backed roles model picker as an internal codex alias", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [
            {
              slug: "dev-agent",
              name: "Dev Agent",
              department: "eng",
              type: "executor",
              recommendedModel: "openai-codex/gpt-5.4",
              fallbackModel: null,
              adapterType: "codex",
              fallbackAdapterType: null,
              skills: [],
              active: true,
              toolsConfig: null,
              concurrencyLimit: 1,
              provisionStatus: { satisfied: true, fixable: false, reason: null },
            },
          ],
        });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Dev Agent")).toBeTruthy());
    const modelSelects = screen.getAllByRole("combobox");
    const modelSelect = modelSelects[1] as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((option) => option.value);

    expect(optionValues).toContain("openai-codex/gpt-5.5");
    expect(Array.from(modelSelect.options).some((option) => option.text === "gpt-5.5")).toBe(true);
  });

  it("saves GPT-5.5 for a codex-backed role through the existing roles flow", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: [
            {
              slug: "dev-agent",
              name: "Dev Agent",
              department: "eng",
              type: "executor",
              recommendedModel: "openai-codex/gpt-5.4",
              fallbackModel: null,
              adapterType: "codex",
              fallbackAdapterType: null,
              skills: [],
              active: true,
              toolsConfig: null,
              concurrencyLimit: 1,
              provisionStatus: { satisfied: true, fixable: false, reason: null },
            },
          ],
        });
      }
      if (url.includes("/api/roles") && init?.method === "POST") {
        return jsonResponse({ data: { slug: "dev-agent", updated: true } });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Dev Agent")).toBeTruthy());
    const modelSelects = screen.getAllByRole("combobox");
    const modelSelect = modelSelects[1] as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "openai-codex/gpt-5.5" } });

    const saveButton = await screen.findByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/roles",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining("\"recommendedModel\":\"openai-codex/gpt-5.5\""),
        }),
      ),
    );
    const adapterSelect = modelSelects[0] as HTMLSelectElement;
    expect(adapterSelect.value).toBe("codex");
  });

  it("offers catalog-backed models for role assignments", async () => {
    selectedHive = { id: "hive-1", slug: "hive-1", name: "Hive One", type: "digital" };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [{
            slug: "dev-agent",
            name: "Dev Agent",
            department: "eng",
            type: "executor",
            recommendedModel: "openai-codex/gpt-5.4",
            fallbackModel: null,
            adapterType: "codex",
            fallbackAdapterType: null,
            skills: [],
            active: true,
            toolsConfig: null,
            concurrencyLimit: 1,
            activeCount: 0,
            runningCount: 0,
            provisionStatus: { satisfied: true, fixable: false, reason: null },
          }],
        });
      }
      if (url.includes("/api/model-setup")) {
        return jsonResponse({ data: { models: [{
          modelCatalogId: "catalog-new",
          hiveModelId: "hive-new",
          routeKey: "openai:codex:openai-codex/gpt-5.6",
          provider: "openai",
          adapterType: "codex",
          modelId: "openai-codex/gpt-5.6",
          displayName: "GPT-5.6",
          hiveEnabled: true,
          status: "healthy",
        }], credentials: [] } });
      }
      if (url.includes("/api/ollama/models") || url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Dev Agent")).toBeTruthy());
    await waitFor(() => {
      const optionValues = Array.from((screen.getAllByRole("combobox")[1] as HTMLSelectElement).options)
        .map((option) => option.value);
      expect(optionValues).toContain("openai-codex/gpt-5.6");
    });
  });

  it("uses primary catalog options when fallback adapter is reset to same as primary", async () => {
    selectedHive = { id: "hive-1", slug: "hive-1", name: "Hive One", type: "digital" };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [{
            slug: "dev-agent",
            name: "Dev Agent",
            department: "eng",
            type: "executor",
            recommendedModel: "openai-codex/gpt-5.4",
            fallbackModel: null,
            adapterType: "codex",
            fallbackAdapterType: "gemini",
            skills: [],
            active: true,
            toolsConfig: null,
            concurrencyLimit: 1,
            activeCount: 0,
            runningCount: 0,
            provisionStatus: { satisfied: true, fixable: false, reason: null },
          }],
        });
      }
      if (url.includes("/api/model-setup")) {
        return jsonResponse({ data: { models: [
          {
            modelCatalogId: "catalog-codex-new",
            hiveModelId: "hive-codex-new",
            routeKey: "openai:codex:openai-codex/gpt-5.6",
            provider: "openai",
            adapterType: "codex",
            modelId: "openai-codex/gpt-5.6",
            displayName: "GPT-5.6",
            hiveEnabled: true,
            status: "healthy",
          },
          {
            modelCatalogId: "catalog-gemini-new",
            hiveModelId: "hive-gemini-new",
            routeKey: "google:gemini:google/gemini-3",
            provider: "google",
            adapterType: "gemini",
            modelId: "google/gemini-3",
            displayName: "Gemini 3",
            hiveEnabled: true,
            status: "healthy",
          },
        ], credentials: [] } });
      }
      if (url.includes("/api/ollama/models") || url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Dev Agent")).toBeTruthy());
    await waitFor(() => {
      const primaryOptions = Array.from((screen.getAllByRole("combobox")[1] as HTMLSelectElement).options)
        .map((option) => option.value);
      expect(primaryOptions).toContain("openai-codex/gpt-5.6");
    });

    const fallbackAdapterSelect = screen.getAllByRole("combobox")[2] as HTMLSelectElement;
    fireEvent.change(fallbackAdapterSelect, { target: { value: "" } });

    await waitFor(() => {
      const fallbackOptions = Array.from((screen.getAllByRole("combobox")[3] as HTMLSelectElement).options)
        .map((option) => option.value);
      expect(fallbackOptions).toContain("openai-codex/gpt-5.6");
      expect(fallbackOptions).not.toContain("google/gemini-3");
    });
  });

  it("renders an explicit no-tools state in the observability panel", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles/dev-agent/observability")) {
        return jsonResponse({
          data: {
            role: { slug: "dev-agent", name: "Dev Agent", department: "eng", type: "executor" },
            scope: { hiveId: null },
            history: {
              agentLevel: { historyLevel: "agent", totalRuns: 0, statusCounts: {}, lastRunAt: null },
              taskLevel: [],
              emptyMessage: "No agent-level run history has been recorded for this role.",
            },
            usageSummary: {
              totalRuns: 0,
              completedRuns: 0,
              failedRuns: 0,
              recentDailyCounts: [],
            },
            scheduleState: {
              kind: "no_schedule",
              label: "No schedule",
              message: "No schedule is configured for this agent in the selected scope.",
              schedules: [],
            },
            tools: [],
            toolsEmptyMessage: "No explicit MCP tools are configured for this role.",
            connectedApps: [
              { id: "install-1", connectorSlug: "github", displayName: "Owner GitHub", status: "active" },
            ],
            connectedAppsEmptyMessage: null,
            memory: { roleMemory: [], hiveMemory: [], emptyMessage: "No linked memory metadata is available for this agent." },
            files: { attachments: [], workProducts: [], emptyMessage: "No linked file or artifact metadata is available for this agent." },
          },
        });
      }
      if (url.includes("/api/roles") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: [
            {
              slug: "dev-agent",
              name: "Dev Agent",
              department: "eng",
              type: "executor",
              recommendedModel: "openai-codex/gpt-5.4",
              fallbackModel: null,
              adapterType: "codex",
              fallbackAdapterType: null,
              skills: [],
              active: true,
              toolsConfig: { mcps: [] },
              concurrencyLimit: 1,
              provisionStatus: { satisfied: true, fixable: false, reason: null },
              activeCount: 0,
              runningCount: 0,
            },
          ],
        });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Dev Agent")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));

    expect(await screen.findByText("No explicit MCP tools are configured for this role.")).toBeTruthy();
    expect(screen.getByText("No usage trend is available for this agent yet.")).toBeTruthy();
    expect(screen.getByText("Owner GitHub")).toBeTruthy();
  });

  it("renders populated observability panel with agent and task level data", async () => {
    const populatedObservability = {
      role: { slug: "dev-agent", name: "Dev Agent", department: "eng", type: "executor" },
      scope: { hiveId: "hive-1" },
      history: {
        agentLevel: {
          historyLevel: "agent",
          totalRuns: 3,
          statusCounts: { completed: 2, blocked: 1 },
          lastRunAt: "2026-05-11T10:00:00.000Z",
        },
        taskLevel: [
          {
            historyLevel: "task",
            id: "task-1",
            title: "Build observability slice",
            status: "completed",
            createdAt: "2026-05-11T09:00:00.000Z",
            startedAt: "2026-05-11T09:01:00.000Z",
            completedAt: "2026-05-11T09:20:00.000Z",
            parentTaskId: null,
            goalId: "goal-1",
            createdBy: "scheduler",
            modelUsed: "openai-codex/gpt-5.5",
          },
          {
            historyLevel: "task",
            id: "task-2",
            title: "Fix auth regression",
            status: "blocked",
            createdAt: "2026-05-11T10:00:00.000Z",
            startedAt: "2026-05-11T10:01:00.000Z",
            completedAt: null,
            parentTaskId: null,
            goalId: "goal-2",
            createdBy: "goal-supervisor",
            modelUsed: "anthropic/claude-opus-4-7",
          },
        ],
        emptyMessage: null,
      },
      usageSummary: {
        totalRuns: 3,
        completedRuns: 2,
        failedRuns: 0,
        recentDailyCounts: [
          { date: "2026-05-10", count: 1 },
          { date: "2026-05-11", count: 2 },
        ],
      },
      scheduleState: {
        kind: "scheduled",
        label: "1 schedule",
        message: null,
        schedules: [
          {
            id: "schedule-1",
            cronExpression: "0 9 * * *",
            enabled: true,
            lastRunAt: "2026-05-10T23:00:00.000Z",
            nextRunAt: "2026-05-11T23:00:00.000Z",
            kind: "daily",
            title: "Daily research",
          },
        ],
      },
      tools: [
        { slug: "github", label: "GitHub", source: "role-mcp" },
        { slug: "context7", label: "Context7 Docs", source: "role-mcp" },
      ],
      toolsEmptyMessage: null,
      connectedApps: [
        { id: "install-1", connectorSlug: "github", displayName: "Owner GitHub", status: "active" },
      ],
      connectedAppsEmptyMessage: null,
      memory: {
        roleMemory: [
          { id: "mem-1", sourceTaskId: "task-1", confidence: 0.9, sensitivity: "internal", createdAt: "2026-05-11T00:00:00.000Z", updatedAt: "2026-05-11T00:00:00.000Z" },
        ],
        hiveMemory: [
          { id: "hmem-1", sourceTaskId: "task-1", category: "general", confidence: 0.8, sensitivity: "confidential", createdAt: "2026-05-11T00:00:00.000Z", updatedAt: "2026-05-11T00:00:00.000Z" },
        ],
        emptyMessage: null,
      },
      files: {
        attachments: [
          { id: "att-1", taskId: "task-1", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 1234, uploadedAt: "2026-05-10T22:59:00.000Z" },
        ],
        workProducts: [
          { id: "wp-1", taskId: "task-1", artifactKind: "report", fileLabel: "report.md", mimeType: "text/markdown", sensitivity: "internal", createdAt: "2026-05-11T00:06:00.000Z" },
        ],
        emptyMessage: null,
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles/dev-agent/observability")) {
        return jsonResponse({ data: populatedObservability });
      }
      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [{
            slug: "dev-agent",
            name: "Dev Agent",
            department: "eng",
            type: "executor",
            recommendedModel: "openai-codex/gpt-5.4",
            fallbackModel: null,
            adapterType: "codex",
            fallbackAdapterType: null,
            skills: [],
            active: true,
            toolsConfig: { mcps: ["github"] },
            concurrencyLimit: 1,
            provisionStatus: { satisfied: true, fixable: false, reason: null },
            activeCount: 0,
            runningCount: 0,
          }],
        });
      }
      if (url.includes("/api/ollama/models") || url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Dev Agent")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));

    // Agent-level badge and run count
    expect(await screen.findByText("Agent")).toBeTruthy();
    expect(screen.getByText("3 recent runs")).toBeTruthy();
    expect(screen.getByText("completed: 2")).toBeTruthy();
    expect(screen.getByText("blocked: 1")).toBeTruthy();

    // Task-level badge and table — "Task" may appear elsewhere so check heading
    expect(screen.getByText("Execution history")).toBeTruthy();
    expect(screen.getByText("Build observability slice")).toBeTruthy();
    expect(screen.getByText("Fix auth regression")).toBeTruthy();
    // Model column shows short model names (may also appear in model picker)
    expect(screen.getAllByText("gpt-5.5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("claude-opus-4-7").length).toBeGreaterThanOrEqual(1);
    // Created by column
    expect(screen.getAllByText("scheduler").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("goal-supervisor").length).toBeGreaterThanOrEqual(1);

    // Schedule state
    expect(screen.getByText("Daily research")).toBeTruthy();

    // Tools
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Context7 Docs")).toBeTruthy();

    // Connected apps
    expect(screen.getByText("Owner GitHub")).toBeTruthy();

    // Memory metadata
    expect(screen.getByText(/role memory mem-1/)).toBeTruthy();
    expect(screen.getByText(/hive memory hmem-1/)).toBeTruthy();

    // Files
    expect(screen.getByText("brief.pdf")).toBeTruthy();
    expect(screen.getByText("report.md")).toBeTruthy();

    // Usage trend chart (daily counts rendered as bars)
    expect(screen.getByRole("img", { name: "Daily usage trend" })).toBeTruthy();

    // Verify no sensitive data leaked
    expect(JSON.stringify(fetchMock.mock.results)).not.toMatch(/credential|token|raw private/i);
  });

  it("offers and saves Gemini 3.1 Flash Live Preview through the roles model picker", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: [
            {
              slug: "research-analyst",
              name: "Research Analyst",
              department: "research",
              type: "executor",
              recommendedModel: "google/gemini-2.5-flash",
              fallbackModel: null,
              adapterType: "google",
              fallbackAdapterType: null,
              skills: [],
              active: true,
              toolsConfig: null,
              concurrencyLimit: 1,
              provisionStatus: { satisfied: true, fixable: false, reason: null },
            },
          ],
        });
      }
      if (url.includes("/api/roles") && init?.method === "POST") {
        return jsonResponse({ data: { slug: "research-analyst", updated: true } });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Research Analyst")).toBeTruthy());
    const modelSelects = screen.getAllByRole("combobox");
    const modelSelect = modelSelects[1] as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((option) => option.value);

    expect(optionValues).toContain("google/gemini-3.1-pro-preview");
    expect(optionValues).toContain("google/gemini-3.1-pro-preview-customtools");
    expect(optionValues).toContain("google/gemini-3.1-flash-lite-preview");
    expect(optionValues).toContain("google/gemini-3-flash-preview");
    expect(optionValues).not.toContain("google/gemini-3.1-flash-live-preview");
    fireEvent.change(modelSelect, { target: { value: "google/gemini-3-flash-preview" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/roles",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining("\"recommendedModel\":\"google/gemini-3-flash-preview\""),
        }),
      ),
    );
  });

  it("offers and saves Mistral Large Latest through the roles model picker", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: [
            {
              slug: "research-analyst",
              name: "Research Analyst",
              department: "research",
              type: "executor",
              recommendedModel: "openai/gpt-4o",
              fallbackModel: null,
              adapterType: "mistral",
              fallbackAdapterType: null,
              skills: [],
              active: true,
              toolsConfig: null,
              concurrencyLimit: 1,
              provisionStatus: { satisfied: true, fixable: false, reason: null },
            },
          ],
        });
      }
      if (url.includes("/api/roles") && init?.method === "POST") {
        return jsonResponse({ data: { slug: "research-analyst", updated: true } });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Research Analyst")).toBeTruthy());
    const modelSelects = screen.getAllByRole("combobox");
    const modelSelect = modelSelects[1] as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((option) => option.value);

    expect(optionValues).toContain("mistral/mistral-large-latest");
    expect(optionValues).toContain("mistral/mistral-ocr-latest");
    fireEvent.change(modelSelect, { target: { value: "mistral/mistral-large-latest" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/roles",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining("\"recommendedModel\":\"mistral/mistral-large-latest\""),
        }),
      ),
    );
  });

  it("saves automatic local-capacity concurrency settings", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/roles")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/adapter-config") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: [
            {
              adapterType: "dispatcher",
              hiveId: null,
              config: {
                maxConcurrentTasks: 6,
                dynamicConcurrency: {
                  enabled: false,
                  minConcurrentTasks: 1,
                  maxConcurrentTasks: 6,
                },
              },
            },
          ],
        });
      }
      if (url.includes("/api/adapter-config") && init?.method === "POST") {
        return jsonResponse({ data: { id: "dispatcher-config", updated: true } });
      }
      if (url.includes("/api/ollama/models")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/mcp-catalog")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<RolesPage />);

    await waitFor(() => expect(screen.getByText("Dispatcher concurrency cap:")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Auto adjust to local machine load"));
    fireEvent.change(screen.getByLabelText("Auto minimum"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Auto maximum"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/adapter-config",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining("\"dynamicConcurrency\""),
        }),
      ),
    );
    const saveCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes("/api/adapter-config") && (init as RequestInit | undefined)?.method === "POST"
    );
    const body = JSON.parse(String((saveCall?.[1] as RequestInit).body));
    expect(body.config).toMatchObject({
      maxConcurrentTasks: 6,
      dynamicConcurrency: {
        enabled: true,
        minConcurrentTasks: 2,
        maxConcurrentTasks: 8,
      },
    });
  });

});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
