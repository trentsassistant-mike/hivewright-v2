// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HiveDetailPage from "../../src/app/(dashboard)/hives/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "hive-1" }),
  usePathname: () => "/hives/hive-1",
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe("HiveDetailPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/hives/hive-1") {
        return new Response(
          JSON.stringify({
            data: {
              id: "hive-1",
              slug: "alpha",
              name: "Alpha Hive",
              type: "digital",
              description: "Test hive",
              mission: "Ship alpha",
              workspacePath: null,
              createdAt: "2026-04-01T00:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }

      if (url === "/api/hives/hive-1/targets") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exposes the ideas route in the hive section navigation", async () => {
    renderWithQueryClient(<HiveDetailPage />);

    await waitFor(() => expect(screen.getByDisplayValue("Alpha Hive")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Targets" }).getAttribute("href")).toBe("/hives/hive-1");
    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute("href")).toBe("/hives/hive-1/ideas");
    expect(screen.getByRole("link", { name: "Goals" }).getAttribute("href")).toBe("/goals?hiveId=hive-1");
    expect(screen.getByRole("link", { name: "Decisions" }).getAttribute("href")).toBe("/decisions?hiveId=hive-1");
  });
});
