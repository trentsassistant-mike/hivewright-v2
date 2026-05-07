// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardShell } from "../../src/components/dashboard-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Hive 2",
      slug: "hive-2",
      type: "business",
    },
    hives: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Hive 2",
        slug: "hive-2",
        type: "business",
      },
    ],
    loading: false,
    selectHive: vi.fn(),
  }),
}));

vi.mock("@/hooks/useVoiceCall", () => ({
  useVoiceCall: () => ({
    status: "idle",
    startCall: vi.fn(),
    endCall: vi.fn(),
  }),
}));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardShell>
        <div>Dashboard content</div>
      </DashboardShell>
    </QueryClientProvider>,
  );
}

describe("<DashboardShell>", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          data: {
            thread: {
              id: "thread-1",
              hiveId: "22222222-2222-4222-8222-222222222222",
              channelId: "dashboard:user",
              status: "active",
              createdAt: new Date().toISOString(),
            },
            messages: [],
            hasMore: false,
          },
        }),
      ),
    );
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("places EA chat in the selected hive menu context instead of the global footer", () => {
    renderShell();

    const hiveSelector = screen.getByRole("combobox");
    const eaButtons = screen.getAllByRole("button", {
      name: /Executive Assistant chat for Hive 2/i,
    });
    expect(eaButtons).toHaveLength(1);

    const eaButton = eaButtons[0];
    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(
      Boolean(hiveSelector.compareDocumentPosition(eaButton) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(eaButton.compareDocumentPosition(dashboardLink) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(screen.getByText("Hive 2 · Ready")).toBeTruthy();

    const globalSettingsFooter = screen.getByRole("link", { name: "Global Settings" }).parentElement;
    expect(globalSettingsFooter?.textContent).not.toContain("EA Chat");
  });

  it("preserves the locked dashboard navigation vocabulary and global Call EA affordance without legacy settings links", () => {
    renderShell();

    for (const label of [
      "Dashboard",
      "Work",
      "Inbox",
      "Operations",
      "Memory",
      "Hives",
      "Schedules",
      "Global Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }

    expect(screen.getByRole("link", { name: "Global Settings" }).getAttribute("href")).toBe("/setup");
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Adapter Config" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Embedding Config" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Call EA" }).length).toBeGreaterThan(0);
  });
});
