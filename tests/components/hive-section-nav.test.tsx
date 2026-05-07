// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HiveSectionNav } from "../../src/components/hive-section-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/hives/hive-2/files",
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

describe("<HiveSectionNav>", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves hive-scoped destinations including Files and quality feedback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { flags: { pendingQualityFeedback: 2 } },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    renderWithQueryClient(<HiveSectionNav hiveId="hive-2" />);

    expect(screen.getByRole("link", { name: "Targets" }).getAttribute("href")).toBe("/hives/hive-2");
    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute("href")).toBe("/hives/hive-2/ideas");
    expect(screen.getByRole("link", { name: "Initiatives" }).getAttribute("href")).toBe("/hives/hive-2/initiatives");
    expect(screen.getByRole("link", { name: "Files" }).getAttribute("href")).toBe("/hives/hive-2/files");
    expect(screen.getByRole("link", { name: "Files" }).getAttribute("aria-current")).toBe("page");
    expect((await screen.findByRole("link", { name: "Quality feedback" })).getAttribute("href")).toBe(
      "/quality-feedback?hiveId=hive-2",
    );
  });
});
