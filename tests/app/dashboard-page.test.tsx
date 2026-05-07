// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DashboardPage from "../../src/app/(dashboard)/page";

class MockEventSource {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  close() {}
}

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: { id: "biz-dash", name: "Dashy" },
    loading: false,
  }),
}));

describe("DashboardPage", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/brief")) {
        return new Response(
          JSON.stringify({
            data: {
              flags: { urgentDecisions: 0, totalPendingDecisions: 1, stalledGoals: 0, waitingGoals: 0, atRiskGoals: 0, unresolvableTasks: 0, expiringCreds: 0 },
              pendingDecisions: [{ id: "d1", title: "Test decision", priority: "normal", context: "ctx", createdAt: new Date().toISOString(), ageHours: 1 }],
              goals: [{ id: "g1", title: "Test goal", status: "active", health: "on_track", progress: { done: 1, failed: 0, open: 2, total: 3 }, idleHours: 2, pendingDecisions: 0, budgetCents: null, spentCents: 0 }],
              recentCompletions: [],
              newInsights: [],
              costs: { todayCents: 0, weekCents: 0, monthCents: 500 },
              activity: { tasksCompleted24h: 0, tasksFailed24h: 0, goalsCompleted7d: 0 },
              initiative: {
                latestRun: null,
                last7d: {
                  windowHours: 168,
                  runCount: 0,
                  completedRuns: 0,
                  failedRuns: 0,
                  evaluatedCandidates: 0,
                  createdItems: 0,
                  suppressedItems: 0,
                  runFailures: 0,
                  suppressionReasons: [],
                },
              },
              generatedAt: new Date().toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/active-tasks")) {
        return new Response(
          JSON.stringify({
            tasks: [{ id: "t-x", title: "Build X", assignedTo: "dev-agent", startedAt: null, modelUsed: null }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/active-supervisors")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                goalId: "g-map",
                goalShortId: "g-map",
                title: "Ship mapped goal",
                threadId: "thread-map",
                lastActivityAt: new Date().toISOString(),
                state: "running",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/supervisor-reports")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it("renders hive name, Owner Brief, and live agents", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DashboardPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Dashy")).toBeTruthy());
    // Owner Brief renders the pending decision title
    await waitFor(() => expect(screen.getByText("Test decision")).toBeTruthy());
    expect(screen.getByText("Waiting on you")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Operations map")).toBeTruthy());
    expect(screen.getByText("Dashy relationship view")).toBeTruthy();
    expect(screen.getAllByText("Ship mapped goal").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("dev-agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Recent runs")).toBeNull();
    // Supervisor findings panel renders (empty-state copy since mock returns []).
    expect(screen.getByText("Supervisor findings")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/No supervisor runs yet/i)).toBeTruthy(),
    );
    // And the ActiveAgentGrid still shows below
    await waitFor(() => expect(screen.getAllByText("Build X").length).toBeGreaterThanOrEqual(1));
  });
});
