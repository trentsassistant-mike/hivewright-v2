// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleDetailView } from "./schedule-detail-view";
import { ScheduleEditModal } from "./schedule-edit-modal";
import { SchedulesTable, type ScheduleListItem } from "./schedules-table";
import type { ScheduleDetail } from "@/schedules/detail";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const detail: ScheduleDetail = {
  schedule: {
    id: "schedule-1",
    hiveId: "hive-1",
    cronExpression: "0 9 * * 1",
    taskTemplate: {
      assignedTo: "developer-agent",
      title: "Weekly implementation review",
      brief: "Review merged work\n\n- Check regressions\n- Summarize blockers",
    },
    enabled: true,
    lastRunAt: new Date("2026-04-20T09:00:00.000Z"),
    nextRunAt: new Date("2026-04-27T09:00:00.000Z"),
    createdBy: "goal-supervisor",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  },
  role: {
    slug: "developer-agent",
    name: "Developer Agent",
    department: "Engineering",
    recommendedModel: "anthropic/claude-sonnet-4-6",
    adapterType: "claude-code",
    skills: ["frontend-design", "testing"],
  },
  runHistory: [
    {
      id: "task-1",
      status: "completed",
      startedAt: new Date("2026-04-20T09:01:00.000Z"),
      completedAt: new Date("2026-04-20T09:06:30.000Z"),
      createdAt: new Date("2026-04-20T09:00:00.000Z"),
    },
  ],
  inProcessRuntime: false,
};

const schedules: ScheduleListItem[] = [
  {
    id: "schedule-1",
    cronExpression: "0 9 * * 1",
    taskTemplate: {
      assignedTo: "developer-agent",
      title: "Weekly implementation review",
      brief: "Review merged work",
    },
    enabled: true,
    lastRunAt: "2026-04-20T09:00:00.000Z",
    nextRunAt: "2026-04-27T09:00:00.000Z",
    createdBy: "goal-supervisor",
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScheduleDetailView", () => {
  it("renders schedule, resolved role model, skills, brief, and run history", () => {
    render(<ScheduleDetailView detail={detail} />);

    expect(screen.getByRole("heading", { name: "Weekly implementation review" })).toBeTruthy();
    expect(screen.getByText("Developer Agent")).toBeTruthy();
    expect(screen.getByText("developer-agent - Engineering")).toBeTruthy();
    expect(screen.getByText("anthropic/claude-sonnet-4-6")).toBeTruthy();
    expect(screen.getByText("claude-code")).toBeTruthy();
    expect(screen.getByText("frontend-design")).toBeTruthy();
    expect(screen.getByText("testing")).toBeTruthy();
    expect(screen.getByText(/Check regressions/)).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("5m 30s")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View task" }).getAttribute("href")).toBe("/tasks/task-1");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("surfaces in-process schedules without run task rows", () => {
    render(
      <ScheduleDetailView
        detail={{
          ...detail,
          schedule: {
            ...detail.schedule,
            taskTemplate: { kind: "hive-supervisor-heartbeat", title: "Heartbeat" },
          },
          runHistory: [],
          inProcessRuntime: true,
        }}
      />,
    );

    expect(
      screen.getByText("This schedule runs in-process and does not create individual tasks."),
    ).toBeTruthy();
  });

});

describe("SchedulesTable", () => {
  it("opens a schedule when its row is clicked", () => {
    const onOpenSchedule = vi.fn();

    render(
      <SchedulesTable
        schedules={schedules}
        onOpenSchedule={onOpenSchedule}
        onEdit={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onRequestSchedule={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Weekly implementation review/,
      }),
    );

    expect(onOpenSchedule).toHaveBeenCalledWith("schedule-1");
  });

  it("does not open the row when toggling or deleting", () => {
    const onOpenSchedule = vi.fn();
    const onEdit = vi.fn();
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(
      <SchedulesTable
        schedules={schedules}
        onOpenSchedule={onOpenSchedule}
        onEdit={onEdit}
        onToggle={onToggle}
        onDelete={onDelete}
        onRequestSchedule={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onEdit).toHaveBeenCalledWith(schedules[0]);
    expect(onToggle).toHaveBeenCalledWith("schedule-1", false);
    expect(onDelete).toHaveBeenCalledWith("schedule-1");
    expect(onOpenSchedule).not.toHaveBeenCalled();
  });
});

describe("ScheduleEditModal", () => {
  it("preserves the existing schedule title when editing cron only", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          data: [{ slug: "developer-agent", name: "Developer Agent" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            ...schedules[0],
            cronExpression: "0 10 * * 1",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ScheduleEditModal
        schedule={schedules[0]}
        open
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    await screen.findByRole("option", { name: "Developer Agent (developer-agent)" });

    fireEvent.change(screen.getByLabelText(/Cron expression/), {
      target: { value: "0 10 * * 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string)).toMatchObject({
      id: "schedule-1",
      cronExpression: "0 10 * * 1",
      taskTemplate: {
        assignedTo: "developer-agent",
        title: "Weekly implementation review",
        brief: "Review merged work",
      },
    });
    expect(onSaved).toHaveBeenCalledWith({
      ...schedules[0],
      cronExpression: "0 10 * * 1",
    });
    expect(onClose).toHaveBeenCalled();
  });
});
