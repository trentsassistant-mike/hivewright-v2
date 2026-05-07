/* @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "hive-1" }),
}));

vi.mock("@/components/hive-section-nav", () => ({
  HiveSectionNav: ({ hiveId }: { hiveId: string }) => <nav>Hive nav {hiveId}</nav>,
}));

import HiveFilesPage from "./page";

const fetchMock = vi.fn();

describe("HiveFilesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          items: [
            {
              id: "file-1",
              name: "README.md",
              category: "projects",
              source: "filesystem",
              relativePath: "app/README.md",
              location: "projects/app/README.md",
              sizeBytes: 12,
              createdAt: "2026-05-01T00:00:00.000Z",
              modifiedAt: "2026-05-01T00:00:00.000Z",
              type: "MD",
              extension: ".md",
              mimeType: null,
              previewable: true,
              downloadable: true,
              previewUrl: "/api/hives/hive-1/files?category=projects&action=preview&path=app%2FREADME.md",
              downloadUrl: "/api/hives/hive-1/files?category=projects&action=download&path=app%2FREADME.md",
            },
          ],
        },
      }),
    });
  });

  it("renders all required tabs and file metadata", async () => {
    render(<HiveFilesPage />);

    expect(screen.getByRole("tab", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Work Products" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Attachments" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Generated Docs" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "EA Files" })).toBeTruthy();

    await screen.findByText("README.md");
    expect(screen.getByText("projects/app/README.md")).toBeTruthy();
    expect(screen.getByText("12 B")).toBeTruthy();
  });

  it("switches categories and loads the selected category", async () => {
    render(<HiveFilesPage />);
    await screen.findByText("README.md");

    fireEvent.click(screen.getByRole("tab", { name: "Attachments" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/api/hives/hive-1/files?category=attachments");
    });
  });

  it("previews invalid JSON as raw text without crashing", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            items: [{
              id: "doc-1",
              name: "bad.json",
              category: "generated-docs",
              source: "database",
              relativePath: "goals/goal-1/bad.json",
              location: "goal_documents.body/doc-1",
              sizeBytes: 15,
              createdAt: null,
              modifiedAt: null,
              type: "json",
              extension: ".json",
              mimeType: "application/json",
              previewable: true,
              downloadable: false,
              previewUrl: "/api/hives/hive-1/files?category=generated-docs&action=preview&id=doc-1",
              downloadUrl: null,
            }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            content: "{not valid json",
            contentType: "application/json",
          },
        }),
      });

    render(<HiveFilesPage />);
    await screen.findByText("bad.json");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await screen.findByText("{not valid json");
  });
});
