// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunsTable } from "../../src/components/runs-table";

describe("RunsTable", () => {
  it("renders dense run rows with links and operational metadata", () => {
    render(
      <RunsTable
        rows={[
          {
            id: "task-1",
            title: "Investigate stalled supervisor",
            href: "/tasks/task-1",
            status: { label: "active", tone: "amber" },
            priority: { label: 2, tone: "red" },
            primaryMeta: [{ label: "Role", value: "dev-agent" }],
            secondaryMeta: [{ label: "Created", value: "4/30/2026" }],
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", { name: "Investigate stalled supervisor" });
    expect(link.getAttribute("href")).toBe("/tasks/task-1");
    expect(screen.getAllByText("dev-agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Run")).toBeTruthy();
  });

  it("renders the provided empty state", () => {
    render(<RunsTable rows={[]} emptyState="No tasks found." />);

    expect(screen.getByText("No tasks found.")).toBeTruthy();
  });

  it("supports list-specific headings, row actions, and expanded content", () => {
    const onOpen = vi.fn();

    render(
      <RunsTable
        rows={[
          {
            id: "schedule-1",
            title: "Daily world scan",
            status: { label: "Active", tone: "green" },
            primaryMeta: [{ label: "Role", value: "research-analyst" }],
            secondaryMeta: [{ label: "Next", value: "tomorrow" }],
            expandedContent: <p>0 7 * * *</p>,
            onClick: onOpen,
            actions: <button type="button">Edit</button>,
          },
        ]}
        columns={{ title: "Schedule", primaryMeta: "Role", secondaryMeta: "Run window" }}
      />,
    );

    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.getByText("Run window")).toBeTruthy();
    expect(screen.getByText("0 7 * * *")).toBeTruthy();
    expect(screen.getByRole("button", { name: /daily world scan/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /daily world scan/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
