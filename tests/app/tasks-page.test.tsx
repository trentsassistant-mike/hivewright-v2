// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TasksPage from "../../src/app/(dashboard)/tasks/page";

const mockHive = vi.hoisted(() => ({ id: "hive-1", name: "Hive One" }));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: mockHive,
    loading: false,
  }),
}));

describe("TasksPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps fetched tasks into RunsTable rows without changing task links or filters", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/api/tasks");
      expect(url).toContain("hiveId=hive-1");
      return jsonResponse({
        data: [
          {
            id: "task-1",
            title: "Build RunsTable primitive",
            assignedTo: "dev-agent",
            status: "active",
            priority: 2,
            createdAt: "2026-04-30T01:15:00.000Z",
          },
        ],
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<TasksPage />);

    const link = await screen.findByRole("link", { name: "Build RunsTable primitive" });
    expect(link.getAttribute("href")).toBe("/tasks/task-1");
    expect(screen.getAllByText("dev-agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "completed" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain("status=completed");
  });

  it("preserves the empty state copy", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof globalThis.fetch;

    render(<TasksPage />);

    expect(await screen.findByText("No tasks found.")).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
