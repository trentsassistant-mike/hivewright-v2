"use client";

import { useEffect, useMemo, useState } from "react";
import cronstrue from "cronstrue";

export type EditableSchedule = {
  id: string;
  cronExpression: string;
  taskTemplate: {
    assignedTo?: string;
    title?: string;
    brief?: string;
    [key: string]: unknown;
  };
  enabled: boolean;
  lastRunAt?: string | Date | null;
  nextRunAt?: string | Date | null;
  createdBy?: string;
  createdAt?: string | Date;
  hiveId?: string;
};

type RoleOption = {
  slug: string;
  name: string;
  department?: string | null;
};

type ScheduleEditModalProps = {
  schedule: EditableSchedule;
  open: boolean;
  onClose: () => void;
  onSaved: (schedule: EditableSchedule) => void;
};

export function ScheduleEditModal({
  schedule,
  open,
  onClose,
  onSaved,
}: ScheduleEditModalProps) {
  const [cronExpression, setCronExpression] = useState(schedule.cronExpression);
  const [title, setTitle] = useState(schedule.taskTemplate.title ?? "");
  const [brief, setBrief] = useState(schedule.taskTemplate.brief ?? "");
  const [assignedTo, setAssignedTo] = useState(schedule.taskTemplate.assignedTo ?? "");
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCronExpression(schedule.cronExpression);
    setTitle(schedule.taskTemplate.title ?? "");
    setBrief(schedule.taskTemplate.brief ?? "");
    setAssignedTo(schedule.taskTemplate.assignedTo ?? "");
    setError(null);
  }, [open, schedule]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    fetch("/api/roles")
      .then((response) => response.json())
      .then((body) => {
        if (!cancelled) setRoles(body.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load roles.");
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const cronPreview = useMemo(() => {
    try {
      return cronstrue.toString(cronExpression);
    } catch {
      return "Invalid cron expression";
    }
  }, [cronExpression]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);

    const payload = {
      id: schedule.id,
      cronExpression,
      taskTemplate: {
        ...schedule.taskTemplate,
        assignedTo,
        title,
        brief,
      },
    };

    try {
      const response = await fetch("/api/schedules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body.error ?? "Failed to update schedule.");
        return;
      }

      onSaved(body.data);
      onClose();
    } catch {
      setError("Failed to update schedule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`edit-schedule-${schedule.id}`}
        className="w-full max-w-2xl rounded-lg border bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={`edit-schedule-${schedule.id}`} className="text-lg font-semibold">
              Edit schedule
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              Update the cadence and task template used by the scheduler.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Close
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          <label htmlFor="schedule-cron-expression" className="grid gap-1 text-sm font-medium">
            Cron expression
            <input
              id="schedule-cron-expression"
              value={cronExpression}
              onChange={(event) => setCronExpression(event.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm dark:border-zinc-700"
            />
            <span className="text-xs font-normal text-zinc-500">{cronPreview}</span>
          </label>

          <label htmlFor="schedule-task-title" className="grid gap-1 text-sm font-medium">
            Task title
            <input
              id="schedule-task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />
          </label>

          <label htmlFor="schedule-brief" className="grid gap-1 text-sm font-medium">
            Brief
            <textarea
              id="schedule-brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={6}
              className="rounded-md border bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />
          </label>

          <label htmlFor="schedule-assigned-role" className="grid gap-1 text-sm font-medium">
            Assigned role
            <select
              id="schedule-assigned-role"
              value={assignedTo}
              onChange={(event) => setAssignedTo(event.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            >
              <option value="" disabled>
                Select a role
              </option>
              {roles.map((role) => (
                <option key={role.slug} value={role.slug}>
                  {role.name} ({role.slug})
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
