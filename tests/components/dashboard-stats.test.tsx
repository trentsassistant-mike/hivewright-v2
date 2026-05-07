// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardStats } from "../../src/components/dashboard-stats";

function renderWith(queryClient: QueryClient, hiveId: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardStats hiveId={hiveId} />
    </QueryClientProvider>,
  );
}

describe("<DashboardStats>", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders all four stat cards from /api/dashboard/summary", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          agentsEnabled: 5,
          tasksInProgress: 3,
          monthSpendCents: 1234,
          pendingApprovals: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWith(qc, "biz-6");

    await waitFor(() => expect(screen.getByText("5")).toBeTruthy());
    expect(screen.getByText("Agents Enabled")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Tasks In Progress")).toBeTruthy();
    expect(screen.getByText("$12.34")).toBeTruthy();
    expect(screen.getByText("Month Spend")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Pending Approvals")).toBeTruthy();
  });
});
