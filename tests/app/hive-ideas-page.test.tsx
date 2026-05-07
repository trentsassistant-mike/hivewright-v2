// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HiveIdeasPage from "../../src/app/(dashboard)/hives/[id]/ideas/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "hive-1" }),
  usePathname: () => "/hives/hive-1/ideas",
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

describe("HiveIdeasPage", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/hives/hive-1/ideas?status=open" && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "idea-open",
                title: "Newest idea",
                body: "Fresh note",
                createdBy: "owner",
                createdAt: "2026-04-22T10:30:00.000Z",
                status: "open",
                aiAssessment: "Strong fit with current targets.",
                promotedToGoalId: null,
              },
              {
                id: "idea-older-open",
                title: "Older idea",
                body: null,
                createdBy: "ea",
                createdAt: "2026-04-20T08:00:00.000Z",
                status: "open",
                aiAssessment: null,
                promotedToGoalId: null,
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url === "/api/hives/hive-1/ideas?status=reviewed" && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "idea-reviewed",
                title: "Reviewed idea",
                body: "Ready for a cleaner brief",
                createdBy: "owner",
                createdAt: "2026-04-21T12:00:00.000Z",
                status: "reviewed",
                aiAssessment: null,
                promotedToGoalId: null,
              },
              {
                id: "idea-promoted",
                title: "Promoted idea",
                body: "Already promoted",
                createdBy: "owner",
                createdAt: "2026-04-19T08:00:00.000Z",
                status: "promoted",
                aiAssessment: null,
                promotedToGoalId: "goal-99",
              },
              {
                id: "idea-archived",
                title: "Archived idea",
                body: "Kept for history",
                createdBy: "owner",
                createdAt: "2026-04-18T08:00:00.000Z",
                status: "archived",
                aiAssessment: null,
                promotedToGoalId: null,
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.startsWith("/api/hives/hive-1/ideas/") && url.endsWith("/attachments") && (!init?.method || init.method === "GET")) {
        if (url === "/api/hives/hive-1/ideas/idea-open/attachments") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "att-1",
                  filename: "reference.png",
                  mimeType: "image/png",
                  sizeBytes: 1024,
                  source: "idea",
                },
              ],
            }),
            { status: 200 },
          );
        }

        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      if (url === "/api/hives/hive-1/ideas" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              id: "idea-3",
              title: "Captured from UI",
              body: "Owner note",
              createdBy: "owner",
              createdAt: "2026-04-23T09:00:00.000Z",
              status: "open",
              aiAssessment: null,
              promotedToGoalId: null,
            },
          }),
          { status: 201 },
        );
      }

      if (url === "/api/work" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              type: "goal",
              id: "goal-77",
              title: "Newest idea",
            },
          }),
          { status: 201 },
        );
      }

      if (url === "/api/hives/hive-1/ideas/idea-older-open" && init?.method === "PATCH") {
        return new Response(JSON.stringify({ data: { id: "idea-older-open", status: "archived" } }), {
          status: 200,
        });
      }

      if (url === "/api/hives/hive-1/ideas/idea-open" && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            data: {
              id: "idea-open",
              title: "Newest idea",
              body: "Fresh note",
              createdBy: "owner",
              createdAt: "2026-04-22T10:30:00.000Z",
              status: "promoted",
              aiAssessment: "Strong fit with current targets.",
              promotedToGoalId: "goal-77",
            },
          }),
          { status: 200 },
        );
      }

      if (url === "/api/hives/hive-1/ideas/idea-reviewed" && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            data: {
              id: "idea-reviewed",
              title: "Reviewed idea refined",
              body: "Updated reviewed notes",
              createdBy: "owner",
              createdAt: "2026-04-21T12:00:00.000Z",
              status: "reviewed",
              aiAssessment: null,
              promotedToGoalId: null,
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders the ideas route with hive navigation and idea metadata", async () => {
    renderWithQueryClient(<HiveIdeasPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Ideas" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Targets" }).getAttribute("href")).toBe("/hives/hive-1");
    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute("href")).toBe("/hives/hive-1/ideas");

    await screen.findByText("Newest idea");
    expect(screen.getByText("Older idea")).toBeTruthy();
    expect(screen.getByText("Reviewed idea")).toBeTruthy();
    expect(screen.getByText("Strong fit with current targets.")).toBeTruthy();
    await screen.findByText("reference.png");
    expect(screen.getByRole("link", { name: /Promoted to goal goal-99/i })).toBeTruthy();

    const ideaTitles = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(ideaTitles).toEqual([
      "Newest idea",
      "Reviewed idea",
      "Older idea",
      "Promoted idea",
      "Archived idea",
    ]);
  });

  it("posts a new idea from the inline owner capture UI", async () => {
    renderWithQueryClient(<HiveIdeasPage />);

    await screen.findByText("Newest idea");

    fireEvent.click(screen.getByRole("button", { name: "+ Add idea" }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Captured from UI" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Owner note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save idea" }));

    await waitFor(() => expect(screen.getByText("Captured from UI")).toBeTruthy());
    const articles = screen.getAllByRole("article");
    expect(within(articles[0]).getByRole("heading", { level: 3 }).textContent).toBe(
      "Captured from UI",
    );
    expect(within(articles[0]).getByText("owner")).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/hives/hive-1/ideas",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(screen.getByText("Owner note")).toBeTruthy();
  });

  it("archives an idea and removes it from the default open list", async () => {
    renderWithQueryClient(<HiveIdeasPage />);

    await screen.findByText("Older idea");

    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[2]);

    await waitFor(() => expect(screen.queryByText("Older idea")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hives/hive-1/ideas/idea-older-open",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("promotes an idea via /api/work and shows the resulting goal link", async () => {
    renderWithQueryClient(<HiveIdeasPage />);

    await screen.findByText("Newest idea");

    fireEvent.click(screen.getAllByRole("button", { name: "Promote now" })[0]);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Promoted to goal goal-77/i })).toBeTruthy(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/work",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const promoteCall = fetchMock.mock.calls.find(([url]) => url === "/api/work");
    expect(promoteCall).toBeDefined();
    const promoteBody = JSON.parse(String(promoteCall?.[1]?.body));
    expect(promoteBody.hiveId).toBe("hive-1");
    expect(promoteBody.input.split("\n\n")[0]).toBe("Source idea id: idea-open");
    expect(promoteBody.input).toContain("Title: Newest idea");
    expect(promoteBody.input).toContain("Fresh note");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hives/hive-1/ideas/idea-open",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/hives/hive-1/ideas/idea-open" && init?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse(String(patchCall?.[1]?.body));
    expect(patchBody).toEqual({
      status: "promoted",
      promoted_to_goal_id: "goal-77",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/goals"))).toBe(false);
  });

  it("shows edit only for open/reviewed ideas and saves reviewed edits", async () => {
    renderWithQueryClient(<HiveIdeasPage />);

    await screen.findByText("Reviewed idea");

    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(3);

    const promotedArticle = screen.getByText("Promoted idea").closest("article");
    const archivedArticle = screen.getByText("Archived idea").closest("article");
    expect(promotedArticle).toBeTruthy();
    expect(archivedArticle).toBeTruthy();
    expect(within(promotedArticle!).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(archivedArticle!).queryByRole("button", { name: "Edit" })).toBeNull();

    const reviewedArticle = screen.getByText("Reviewed idea").closest("article");
    expect(reviewedArticle).toBeTruthy();
    fireEvent.click(within(reviewedArticle!).getByRole("button", { name: "Edit" }));

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Reviewed idea refined" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Updated reviewed notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByText("Reviewed idea refined")).toBeTruthy());
    expect(screen.getByText("Updated reviewed notes")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();

    const editPatchCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/hives/hive-1/ideas/idea-reviewed" && init?.method === "PATCH",
    );
    expect(editPatchCall).toBeDefined();
    expect(JSON.parse(String(editPatchCall?.[1]?.body))).toEqual({
      title: "Reviewed idea refined",
      body: "Updated reviewed notes",
    });
  });
});
