"use client";

import type { MouseEvent } from "react";
import { RunsTable, type RunsTableRow } from "@/components/runs-table";

export interface ScheduleListItem {
  id: string;
  cronExpression: string;
  taskTemplate: { assignedTo?: string; title?: string; brief?: string };
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdBy: string;
}

interface SchedulesTableProps {
  schedules: ScheduleListItem[];
  onOpenSchedule: (id: string) => void;
  onEdit: (schedule: ScheduleListItem) => void;
  onToggle: (id: string, enabled: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onRequestSchedule: () => void;
}

export function SchedulesTable({
  schedules,
  onOpenSchedule,
  onEdit,
  onToggle,
  onDelete,
  onRequestSchedule,
}: SchedulesTableProps) {
  const stopRowClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const rows: RunsTableRow[] = schedules.map((schedule) => ({
    id: schedule.id,
    title: schedule.taskTemplate?.title ?? schedule.taskTemplate?.brief ?? "Untitled schedule",
    meta: <span className="font-mono">{schedule.cronExpression}</span>,
    status: {
      label: schedule.enabled ? "Active" : "Paused",
      tone: schedule.enabled ? "green" : "neutral",
    },
    primaryMeta: [{ label: "Role", value: schedule.taskTemplate?.assignedTo ?? "-" }],
    secondaryMeta: [
      {
        label: "Next",
        value: schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "-",
      },
      {
        label: "Last",
        value: schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : "never",
      },
    ],
    onClick: () => onOpenSchedule(schedule.id),
    actions: (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={(event) => {
            stopRowClick(event);
            void onToggle(schedule.id, !schedule.enabled);
          }}
          className="text-xs text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        >
          {schedule.enabled ? "Pause" : "Activate"}
        </button>
        <button
          type="button"
          onClick={(event) => {
            stopRowClick(event);
            onEdit(schedule);
          }}
          className="text-xs text-blue-500 hover:text-blue-700"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={(event) => {
            stopRowClick(event);
            void onDelete(schedule.id);
          }}
          className="text-xs text-red-400 hover:text-red-600"
        >
          Delete
        </button>
      </div>
    ),
  }));

  return (
    <RunsTable
      rows={rows}
      emptyState={
        <>
          No schedules yet.{" "}
          <button onClick={onRequestSchedule} className="underline hover:text-zinc-600">
            Request one through intake.
          </button>
        </>
      }
      ariaLabel="Schedules list"
      columns={{
        title: "Schedule",
        primaryMeta: "Role",
        status: "Status",
        priority: "",
        secondaryMeta: "Run window",
      }}
    />
  );
}
