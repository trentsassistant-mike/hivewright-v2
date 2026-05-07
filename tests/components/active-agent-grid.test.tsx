// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActiveAgentGrid } from "../../src/components/active-agent-grid";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function renderGrid(queryClient: QueryClient, hiveId: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveAgentGrid hiveId={hiveId} />
    </QueryClientProvider>,
  );
}

describe("<ActiveAgentGrid>", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    globalThis.fetch = originalFetch;
  });

  it("renders one AgentCard per active task", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tasks: [
            {
              id: "t-1",
              title: "A",
              assignedTo: "dev-agent",
              startedAt: "2026-04-15T00:00:00Z",
              modelUsed: "anthropic/claude-sonnet-4-6",
            },
            {
              id: "t-2",
              title: "B",
              assignedTo: "ops-agent",
              startedAt: "2026-04-15T00:01:00Z",
              modelUsed: null,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderGrid(qc, "biz-9");

    await waitFor(() => expect(screen.getByText("A")).toBeTruthy());
    expect(screen.getByText("B")).toBeTruthy();
    expect(screen.getByText("dev-agent")).toBeTruthy();
    expect(screen.getByText("ops-agent")).toBeTruthy();
    // Each card exposes a clickable link to its task detail page.
    const links = screen.getAllByTestId("agent-card-link") as HTMLAnchorElement[];
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual([
      "/tasks/t-1",
      "/tasks/t-2",
    ]);
    // Runtime model is shown when known, fallback otherwise.
    const modelLabels = screen
      .getAllByTestId("agent-card-model")
      .map((n) => n.textContent);
    expect(modelLabels).toContain("claude-sonnet-4-6");
    expect(modelLabels).toContain("model pending");
    // Two SSE connections opened (one per card).
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("renders empty-state when no tasks are active", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderGrid(qc, "biz-10");

    await waitFor(() => expect(screen.getByText(/No agents are currently running/)).toBeTruthy());
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
