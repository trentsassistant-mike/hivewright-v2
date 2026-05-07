// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupHealthPage from "../../src/app/(dashboard)/setup/health/page";

const hiveContextMock = vi.hoisted(() => ({
  value: {
    selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" } as
      | { id: string; slug: string; name: string; type: string }
      | null,
    hives: [] as Array<{ id: string; slug: string; name: string; type: string }>,
    loading: false,
    selectHive: () => {},
  },
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => hiveContextMock.value,
}));

describe("SetupHealthPage", () => {
  beforeEach(() => {
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [],
      loading: false,
      selectHive: () => {},
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing when no hive is selected and the context is empty", () => {
    hiveContextMock.value = {
      selected: null,
      hives: [],
      loading: false,
      selectHive: () => {},
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<SetupHealthPage />);

    expect(screen.getByRole("heading", { name: "Setup health" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No hive selected" })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders safely while setup health is loading and then shows rows", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })),
    );

    render(<SetupHealthPage />);

    expect(screen.getByText("Checking setup health...")).toBeTruthy();
    expect(screen.queryByText("1 of 1 ready")).toBeNull();

    resolveFetch(
      new Response(
        JSON.stringify({
          data: {
            hiveId: "hive-1",
            rows: [
              row("models", "Models", "ready", "Ready", "/setup/models", "Review Model Setup"),
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await waitFor(() => expect(screen.getByText("1 of 1 ready")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Models" })).toBeTruthy();
  });

  it("renders all setup health rows with owner-facing statuses and fix links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                hiveId: "hive-1",
                rows: [
                  row("models", "Models", "ready", "Ready", "/setup/models", "Review Model Setup"),
                  row("ea", "EA", "not_set_up", "Not set up yet", "/setup/connectors", "Connect EA"),
                  row("dispatcher", "Work queue", "ready", "Ready", "/tasks", "View work queue"),
                  row("connectors", "Service connections", "pending", "Pending/not checked", "/setup/connectors", "Test connections"),
                  row("schedules", "Recurring work", "not_set_up", "Not set up yet", "/schedules", "Turn on recurring work"),
                  row("memory", "Memory search", "needs_attention", "Needs attention", "/setup/embeddings", "Fix memory search"),
                ],
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    render(<SetupHealthPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Setup health" })).toBeTruthy());
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/setup-health?hiveId=hive-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    for (const title of [
      "Models",
      "EA",
      "Work queue",
      "Service connections",
      "Recurring work",
      "Memory search",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }

    expect(screen.getByText("2 of 6 ready")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect EA" }).getAttribute("href")).toBe("/setup/connectors");
    expect(screen.getByRole("link", { name: "View work queue" }).getAttribute("href")).toBe("/tasks");
    expect(screen.getByRole("link", { name: "Turn on recurring work" }).getAttribute("href")).toBe("/schedules");
    expect(screen.getByRole("link", { name: "Fix memory search" }).getAttribute("href")).toBe("/setup/embeddings");

    const pageText = document.body.textContent ?? "";
    expect(pageText).not.toMatch(/adapter_config|raw model|cron|route hint/i);
    expect(within(screen.getByText("Service connections").closest("article")!).getByText("Pending/not checked")).toBeTruthy();
  });
});

function row(
  key: string,
  title: string,
  status: string,
  statusLabel: string,
  href: string,
  hrefLabel: string,
) {
  return {
    key,
    title,
    status,
    statusLabel,
    summary: `${title} summary.`,
    href,
    hrefLabel,
  };
}
