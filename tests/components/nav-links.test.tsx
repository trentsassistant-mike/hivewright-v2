// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NavLinks } from "../../src/components/nav-links";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: vi.fn(),
}));

import { usePathname } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";

function mockHiveContext() {
  vi.mocked(useHiveContext).mockReturnValue({
    selected: { id: "hive-2", slug: "hive-2", name: "Hive 2", type: "business" },
    hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
    loading: false,
    selectHive: () => {},
  });
}

function mockBriefCount(pendingQualityFeedback: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { flags: { pendingQualityFeedback } },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    ),
  );
}

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

describe("<NavLinks>", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links Ideas to the selected hive and marks it active on the hive ideas route", () => {
    vi.mocked(usePathname).mockReturnValue("/hives/hive-2/ideas");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "hive-2", slug: "hive-2", name: "Hive 2", type: "business" },
      hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    const ideasLink = screen.getByRole("link", { name: "Ideas" });
    expect(ideasLink.getAttribute("href")).toBe("/hives/hive-2/ideas");
    expect(ideasLink.getAttribute("aria-current")).toBe("page");
  });

  it("links Initiatives to the selected hive and marks it active on the hive initiatives route", () => {
    vi.mocked(usePathname).mockReturnValue("/hives/hive-2/initiatives");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "hive-2", slug: "hive-2", name: "Hive 2", type: "business" },
      hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    const initiativesLink = screen.getByRole("link", { name: "Initiatives" });
    expect(initiativesLink.getAttribute("href")).toBe("/hives/hive-2/initiatives");
    expect(initiativesLink.getAttribute("aria-current")).toBe("page");
  });

  it("falls back to the first hive when no hive is selected", () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: null,
      hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute("href")).toBe("/hives/hive-1/ideas");
    expect(screen.getByRole("link", { name: "Initiatives" }).getAttribute("href")).toBe("/hives/hive-1/initiatives");
  });

  it("renders Ideas and Initiatives without duplicate key warnings when no hives are available", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(usePathname).mockReturnValue("/hives");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: null,
      hives: [],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    const ideasLink = screen.getByRole("link", { name: "Ideas" });
    const initiativesLink = screen.getByRole("link", { name: "Initiatives" });
    expect(ideasLink.getAttribute("href")).toBe("/hives");
    expect(initiativesLink.getAttribute("href")).toBe("/hives");
    expect(ideasLink.closest("li")).not.toBe(initiativesLink.closest("li"));
    const consoleMessages = consoleError.mock.calls.map((call) => call.join(" "));
    expect(consoleMessages).not.toContainEqual(
      expect.stringContaining("Encountered two children with the same key"),
    );
  });

  it("keeps Quality feedback visible when there are no pending ratings", () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    expect(screen.getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe("/decisions");
    expect(screen.queryByRole("link", { name: "Quality feedback" })).toBeNull();
    expect(screen.getByRole("link", { name: "Setup" }).getAttribute("href")).toBe("/setup");
    expect(screen.queryByRole("link", { name: "Models" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Setup Health" })).toBeNull();
  });

  it("renders grouped sidebar sections with separated canonical global links", () => {
    vi.mocked(usePathname).mockReturnValue("/setup/models");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    for (const groupLabel of [
      "Dashboard",
      "Work",
      "Inbox",
      "Schedules",
      "Memory",
      "Analytics",
      "Operations",
      "Setup",
      "Global",
    ]) {
      expect(screen.getByRole("group", { name: groupLabel })).toBeTruthy();
    }

    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Operations" }).getAttribute("href")).toBe("/roles");
    expect(screen.queryByRole("link", { name: "Board" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Voice" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Docs" })).toBeNull();
    expect(screen.getByRole("link", { name: "Models" }).getAttribute("href")).toBe("/setup/models");
    expect(screen.getByRole("link", { name: "Setup Health" }).getAttribute("href")).toBe("/setup/health");
    expect(screen.getByRole("link", { name: "Hives" }).getAttribute("href")).toBe("/hives");
    expect(screen.getByRole("link", { name: "Global Settings" }).getAttribute("href")).toBe("/setup");
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("expands only the active route group and keeps the active child route clear", () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    const workGroup = screen.getByRole("group", { name: "Work" });
    const memoryGroup = screen.getByRole("group", { name: "Memory" });
    const workSectionLink = within(workGroup).getByRole("link", { name: "Work" });
    const tasksLink = within(workGroup).getByRole("link", { name: "Tasks" });

    expect(workSectionLink.getAttribute("href")).toBe("/tasks");
    expect(workSectionLink.getAttribute("aria-current")).toBe("page");
    expect(tasksLink.getAttribute("aria-current")).toBe("page");
    expect(within(workGroup).getByRole("link", { name: "Goals" }).getAttribute("href")).toBe("/goals");
    expect(within(memoryGroup).getByRole("link", { name: "Memory" }).getAttribute("href")).toBe("/memory");
    expect(within(memoryGroup).queryByRole("link", { name: "Memory Health" })).toBeNull();
  });

  it("moves expansion from Work to Memory when the current route changes", () => {
    vi.mocked(usePathname).mockReturnValue("/memory/timeline");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    const workGroup = screen.getByRole("group", { name: "Work" });
    const memoryGroup = screen.getByRole("group", { name: "Memory" });
    const memorySectionLink = within(memoryGroup).getByRole("link", { name: "Memory" });
    const timelineLink = within(memoryGroup).getByRole("link", { name: "Memory Timeline" });

    expect(within(workGroup).queryByRole("link", { name: "Tasks" })).toBeNull();
    expect(within(workGroup).queryByRole("link", { name: "Goals" })).toBeNull();
    expect(memorySectionLink.getAttribute("aria-current")).toBe("page");
    expect(timelineLink.getAttribute("href")).toBe("/memory/timeline");
    expect(timelineLink.getAttribute("aria-current")).toBe("page");
    expect(within(memoryGroup).getByRole("link", { name: "Memory Health" }).getAttribute("href")).toBe("/memory/health");
  });

  it("shows a pending count badge for Quality feedback when ratings are waiting", async () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    mockHiveContext();
    mockBriefCount(3);

    renderWithQueryClient(<NavLinks />);

    const inboxLink = screen.getByRole("link", { name: "Inbox" });
    expect(inboxLink.getAttribute("href")).toBe("/decisions");
    expect(screen.queryByRole("link", { name: "Quality feedback" })).toBeNull();
    await waitFor(() => {
      expect(within(inboxLink).getByText("3").textContent).toContain("3");
    });
  });
});
