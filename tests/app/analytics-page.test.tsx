// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AnalyticsPage from "../../src/app/(dashboard)/analytics/page";

const selectedHive = {
  id: "hive-analytics-1",
  slug: "hive-analytics-1",
  name: "Analytics Hive",
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

describe("AnalyticsPage billable usage reporting", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shows processed context and billable cost as separate operator-facing columns", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/analytics")) {
        return new Response(
          JSON.stringify({
            data: {
              totals: {
                totalTasks: 1,
                completed: 1,
                failed: 0,
                totalCostCents: 38,
                totalContextTokens: 1000,
                totalFreshInputTokens: 700,
                totalCachedInputTokens: 300,
              },
              byRole: [
                {
                  assignedTo: "dev-agent",
                  taskCount: 1,
                  totalCostCents: 38,
                  totalContextTokens: 1000,
                  totalFreshInputTokens: 700,
                  totalCachedInputTokens: 300,
                  totalTokensInput: 1000,
                  totalTokensOutput: 250,
                },
              ],
              byGoal: [
                {
                  goalId: "goal-1",
                  goalTitle: "Cost accounting",
                  taskCount: 1,
                  totalCostCents: 38,
                  totalContextTokens: 1000,
                },
              ],
              period: "30d",
              from: null,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText("Cost Analytics")).toBeTruthy());

    expect(screen.getAllByText("Processed Context").length).toBeGreaterThan(0);
    expect(screen.getByText("Fresh Input")).toBeTruthy();
    expect(screen.getByText("Cached Input")).toBeTruthy();
    expect(screen.getAllByText("1,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("700").length).toBeGreaterThan(0);
    expect(screen.getAllByText("300").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.38").length).toBeGreaterThan(0);
  });
});
