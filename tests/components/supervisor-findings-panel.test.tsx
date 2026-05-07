// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SupervisorFindingsPanel } from "../../src/components/supervisor-findings-panel";

const HIVE_ID = "b151c196-5883-4c43-b6e7-d2ed181d2f50";

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    hiveId: HIVE_ID,
    ranAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    report: {
      hiveId: HIVE_ID,
      scannedAt: new Date().toISOString(),
      findings: [
        { id: "f1", kind: "stalled_task", severity: "warn", ref: {}, summary: "", detail: {} },
        { id: "f2", kind: "unsatisfied_completion", severity: "critical", ref: {}, summary: "", detail: {} },
      ],
      metrics: { openTasks: 0, activeGoals: 0, openDecisions: 0, tasksCompleted24h: 0, tasksFailed24h: 0 },
    },
    actions: {
      summary: "two nudges",
      findings_addressed: ["f1", "f2"],
      actions: [
        { kind: "wake_goal", goalId: "g1", reasoning: "" },
        { kind: "noop", reasoning: "" },
      ],
    },
    actionOutcomes: [
      { action: { kind: "wake_goal", goalId: "g1", reasoning: "" }, status: "applied", detail: "" },
      { action: { kind: "noop", reasoning: "" }, status: "skipped", detail: "" },
    ],
    agentTaskId: null,
    freshInputTokens: null,
    cachedInputTokens: null,
    cachedInputTokensKnown: false,
    totalContextTokens: null,
    estimatedBillableCostCents: 42,
    tokensInput: 800,
    tokensOutput: 200,
    costCents: 42,
    ...overrides,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SupervisorFindingsPanel hiveId={HIVE_ID} />
    </QueryClientProvider>,
  );
}

describe("SupervisorFindingsPanel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shows the loading state before the first response arrives", async () => {
    globalThis.fetch = vi.fn(
      () =>
        new Promise(() => {
          // never resolves — keeps the query in `isLoading`
        }),
    ) as unknown as typeof globalThis.fetch;

    renderPanel();
    expect(screen.getByText(/Loading supervisor findings/i)).toBeTruthy();
  });

  it("shows the empty state when the API returns zero reports", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/No supervisor runs yet/i)).toBeTruthy(),
    );
  });

  it("renders report rows with severity badges, action counts, and cost", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/supervisor-reports")) {
        return new Response(
          JSON.stringify({ data: [reportRow()] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    renderPanel();
    // finding count header
    await waitFor(() => expect(screen.getByText(/2 findings/)).toBeTruthy());
    // severity chips
    expect(screen.getByText(/1 critical/i)).toBeTruthy();
    expect(screen.getByText(/1 warn/i)).toBeTruthy();
    // action application counter
    expect(screen.getByText(/actions 1\/2 applied/i)).toBeTruthy();
    // billable cost rendered as "est. $0.42" (processed context vs cost are separate)
    expect(screen.getByText(/est\. \$0\.42/i)).toBeTruthy();
    // summary text from the SupervisorActions payload
    expect(screen.getByText(/two nudges/i)).toBeTruthy();
  });

  it("expands a supervisor report row to show individual finding details", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/supervisor-reports")) {
        return new Response(
          JSON.stringify({
            data: [
              reportRow({
                report: {
                  hiveId: HIVE_ID,
                  scannedAt: new Date().toISOString(),
                  findings: [
                    {
                      id: "stale-task",
                      kind: "stalled_task",
                      severity: "warn",
                      ref: { taskId: "task-123", role: "dev-agent" },
                      summary: "Task has not heartbeated recently.",
                      detail: { lastHeartbeatMinutesAgo: 91 },
                    },
                  ],
                  metrics: {
                    openTasks: 1,
                    activeGoals: 1,
                    openDecisions: 0,
                    tasksCompleted24h: 0,
                    tasksFailed24h: 0,
                  },
                },
              }),
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    renderPanel();

    const toggle = await screen.findByRole("button", { name: /show finding details/i });
    expect(screen.queryByText(/Task has not heartbeated recently/i)).toBeNull();

    fireEvent.click(toggle);

    expect(await screen.findByText(/Task has not heartbeated recently/i)).toBeTruthy();
    expect(screen.getByText(/task-123/i)).toBeTruthy();
    expect(screen.getByText(/lastHeartbeatMinutesAgo/i)).toBeTruthy();
  });

  it("lets the owner run an on-demand supervisor digest without waiting for the schedule", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/supervisor-reports") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              reportId: "r-manual",
              findings: 1,
              summary: "Hive health digest: 1 finding.",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/supervisor-reports")) {
        return new Response(
          JSON.stringify({ data: [reportRow()] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Run digest/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/supervisor-reports?hiveId=${HIVE_ID}`,
        { method: "POST" },
      );
    });
    expect(await screen.findByText(/Hive health digest: 1 finding/i)).toBeTruthy();
  });

  it("falls back to a finding-kind summary when the agent emitted no summary", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [reportRow({ actions: null, actionOutcomes: null, costCents: null, estimatedBillableCostCents: null })],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    renderPanel();
    await waitFor(() => expect(screen.getByText(/stalled task/i)).toBeTruthy());
    // Billable cost line is hidden when estimatedBillableCostCents and costCents are both null
    expect(screen.queryByText(/est\. \$/i)).toBeNull();
    // actions counter falls back to 0/0 when no outcomes
    expect(screen.getByText(/actions 0\/0 applied/i)).toBeTruthy();
  });

  it("shows an error message when the API fails", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("boom", { status: 500 }),
    ) as unknown as typeof globalThis.fetch;

    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/Supervisor findings unavailable/i)).toBeTruthy(),
    );
  });
});
