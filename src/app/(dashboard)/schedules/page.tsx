"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";
import { ScheduleEditModal } from "@/components/schedule-edit-modal";
import { SchedulesTable, type ScheduleListItem } from "@/components/schedules-table";

export default function SchedulesPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [schedules, setSchedules] = useState<ScheduleListItem[]>([]);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleListItem | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/schedules?hiveId=${selected.id}`)
      .then((r) => r.json())
      .then((b) => setSchedules(b.data || []));
  }, [selected]);

  const toggle = async (id: string, enabled: boolean) => {
    await fetch("/api/schedules", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, enabled }) });
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, enabled } : s));
  };

  const deleteSchedule = async (id: string) => {
    if (!confirm("Delete this schedule?")) return;
    await fetch("/api/schedules", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setSchedules(prev => prev.filter(s => s.id !== id));
  };

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Schedules</h1>
        <button
          onClick={() => router.push("/work-intake")}
          className="rounded-md border px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Request a schedule →
        </button>
      </div>

      <p className="text-sm text-zinc-500">
        Schedules are created through work intake — describe what you want automated and the system will set it up.
      </p>

      <SchedulesTable
        schedules={schedules}
        onOpenSchedule={(id) => router.push(`/schedules/${id}`)}
        onEdit={setEditingSchedule}
        onToggle={toggle}
        onDelete={deleteSchedule}
        onRequestSchedule={() => router.push("/work-intake")}
      />

      {editingSchedule ? (
        <ScheduleEditModal
          schedule={editingSchedule}
          open={Boolean(editingSchedule)}
          onClose={() => setEditingSchedule(null)}
          onSaved={(updated) => {
            setSchedules((prev) =>
              prev.map((schedule) =>
                schedule.id === updated.id
                  ? {
                      ...schedule,
                      cronExpression: updated.cronExpression,
                      taskTemplate: updated.taskTemplate,
                      enabled: updated.enabled,
                      lastRunAt: updated.lastRunAt?.toString() ?? null,
                      nextRunAt: updated.nextRunAt?.toString() ?? null,
                    }
                  : schedule,
              ),
            );
          }}
        />
      ) : null}
    </div>
  );
}
