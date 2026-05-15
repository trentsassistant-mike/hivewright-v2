// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OwnerBrief } from "../../src/components/owner-brief";

const HIVE_ID = "b151c196-5883-4c43-b6e7-d2ed181d2f50";

const recentCompletions = [
  {
    id: "00000000-0000-0000-0000-000000000aaa",
    title: "[Doctor] Diagnose: Fix analytics task cap and add period filters",
    role: "doctor",
    completedAt: new Date(Date.now() - 60_000).toISOString(),
  },
  {
    id: "00000000-0000-0000-0000-000000000bbb",
    title: "[QA] Review: Keep dashboard shell and theme on docs page",
    role: "qa",
    completedAt: new Date(Date.now() - 14 * 3_600_000).toISOString(),
  },
];

function briefResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: {
      flags: {
        urgentDecisions: 0,
        totalPendingDecisions: 0,
        stalledGoals: 0,
        waitingGoals: 0,
        atRiskGoals: 0,
        unresolvableTasks: 0,
        expiringCreds: 0,
      },
      pendingDecisions: [],
      goals: [],
      recentCompletions,
      newInsights: [],
      costs: { todayCents: 0, weekCents: 0, monthCents: 0 },
      activity: { tasksCompleted24h: 2, tasksFailed24h: 0, goalsCompleted7d: 0 },
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
      ...overrides,
    },
  };
}

function renderBrief() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OwnerBrief hiveId={HIVE_ID} />
    </QueryClientProvider>,
  );
}

describe("OwnerBrief recently completed", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/brief")) {
        return new Response(JSON.stringify(briefResponse()), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders each completed item as a link to its task detail page", async () => {
    renderBrief();
    await waitFor(() => expect(screen.getByText("Recently completed")).toBeTruthy());

    for (const t of recentCompletions) {
      const link = await screen.findByRole("link", {
        name: new RegExp(`View completed task: ${t.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      });
      expect(link).toBeTruthy();
      expect(link.getAttribute("href")).toBe(`/tasks/${t.id}`);
    }
  });

  it("marks completed items as keyboard-focusable", async () => {
    renderBrief();
    await waitFor(() => expect(screen.getByText("Recently completed")).toBeTruthy());
    const links = await screen.findAllByRole("link", { name: /View completed task:/ });
    expect(links.length).toBe(recentCompletions.length);
    for (const l of links) {
      // <a href="..."> is focusable by default; tabIndex must not be -1
      const tabIndex = l.getAttribute("tabindex");
      expect(tabIndex === null || tabIndex !== "-1").toBe(true);
    }
  });

  it("shows the empty-state message when there are no completions", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/brief")) {
        return new Response(
          JSON.stringify(briefResponse({ recentCompletions: [] })),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    renderBrief();
    await waitFor(() =>
      expect(screen.getByText("Nothing completed in the last 24 hours.")).toBeTruthy(),
    );
    // No task links should be rendered in the empty state.
    const taskLinks = screen
      .queryAllByRole("link")
      .filter((l) => (l.getAttribute("href") ?? "").startsWith("/tasks/"));
    expect(taskLinks.length).toBe(0);
  });

  it("renders the AI spend budget surface with warning state details", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/brief")) {
        return new Response(
          JSON.stringify(briefResponse({
            aiBudget: {
              currency: "USD",
              capCents: 10_000,
              consumedCents: 8_500,
              remainingCents: 1_500,
              progressPct: 85,
              warningThresholdPct: 80,
              breachedThresholdPct: 100,
              state: "warning",
              window: "monthly",
              overBudgetCents: 0,
              enforcement: {
                mode: "creation_pause",
                blocksNewWork: false,
                reason: null,
              },
            },
          })),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    renderBrief();

    await waitFor(() => expect(screen.getByText("AI spend budget")).toBeTruthy());
    expect(screen.queryByText(new RegExp(`Pilot ${"AI"} budget`))).toBeNull();
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("$100.00")).toBeTruthy();
    expect(screen.getByText("$85.00")).toBeTruthy();
    expect(screen.getByText("$15.00")).toBeTruthy();
    expect(screen.getByText("85% used")).toBeTruthy();
  });
});
