// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PipelinesPage from "../../src/app/(dashboard)/pipelines/page";

const selectedHive = vi.hoisted(() => ({ id: "hive-1", name: "Hive One" }));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: selectedHive,
    loading: false,
  }),
}));

describe("PipelinesPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("frames pipeline templates as governed business procedures, not the default agent workflow", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      data: {
        templates: [
          {
            id: "template-month-end",
            scope: "hive",
            hiveId: "hive-1",
            slug: "month-end",
            name: "Month-end Close",
            description: "Reconcile accounts and prepare owner evidence.",
            department: "finance",
            version: 2,
            active: true,
            stepCount: 2,
            steps: [
              {
                id: "step-1",
                order: 1,
                slug: "reconcile",
                name: "Reconcile accounts",
                roleSlug: "finance-agent",
                duty: "Reconcile bank accounts.",
                qaRequired: true,
              },
            ],
          },
        ],
        runs: [],
      },
    })) as unknown as typeof globalThis.fetch;

    render(<PipelinesPage />);

    await waitFor(() => expect(screen.getByText("Business procedures")).toBeTruthy());
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/pipelines?hiveId=hive-1&includeInactive=true"),
      );
    });
    expect(screen.getByText(/owner-approved, repeatable procedures/i)).toBeTruthy();
    expect(screen.getAllByText(/mandatory owner process/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Draft or suggested procedures stay optional until owner approved/i)).toBeTruthy();
    expect(screen.getByText(/procedures are not the default agent workflow/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /procedure library/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /capture and import/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /screen capture/i }).getAttribute("href")).toBe("/setup/workflow-capture");
    expect(screen.getByRole("link", { name: /sop import/i }).getAttribute("href")).toBe("/setup/sop-importer");
    expect(screen.queryByText(/Visual timelines for active workflow runs/i)).toBeNull();
    expect(screen.getByText(/No procedure runs yet/i)).toBeTruthy();
  });

  it("shows create, edit, archive, delete, and step reorder controls for procedure templates", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      data: {
        templates: [
          {
            id: "template-draft",
            scope: "hive",
            hiveId: "hive-1",
            slug: "draft-procedure",
            name: "Draft Procedure",
            description: "Draft owner procedure.",
            department: "operations",
            version: 1,
            active: false,
            stepCount: 1,
            steps: [
              {
                id: "step-1",
                order: 1,
                slug: "draft-step",
                name: "Draft step",
                roleSlug: "ops-agent",
                duty: "Draft the step.",
                qaRequired: false,
              },
            ],
          },
        ],
        runs: [],
      },
    })) as unknown as typeof globalThis.fetch;

    render(<PipelinesPage />);

    expect(await screen.findByRole("button", { name: "Create procedure" })).toBeTruthy();
    expect(screen.queryByText(/Create procedure coming next/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Draft Procedure" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive Draft Procedure" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Draft Procedure" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create procedure" }));
    expect(screen.getByRole("heading", { name: "Create procedure template" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Slug")).toBeTruthy();
    expect(screen.getByLabelText("Department")).toBeTruthy();
    expect(screen.getByLabelText("Save as approved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add step" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move step down" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove step" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit Draft Procedure" }));
    const form = screen.getByRole("form", { name: "Procedure template form" });
    expect(within(form).getByDisplayValue("Draft Procedure")).toBeTruthy();
    expect(within(form).getByDisplayValue("Draft step")).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
