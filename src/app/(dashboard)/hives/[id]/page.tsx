"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { HiveSectionNav } from "@/components/hive-section-nav";

interface Hive {
  id: string;
  slug: string;
  name: string;
  type: string;
  description: string | null;
  mission: string | null;
  workspacePath: string | null;
  createdAt: string;
}

type TargetStatus = "open" | "achieved" | "abandoned";

interface Target {
  id: string;
  hiveId: string;
  title: string;
  targetValue: string | null;
  deadline: string | null;
  notes: string | null;
  sortOrder: number;
  status: TargetStatus;
}

export default function HiveDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [hive, setHive] = useState<Hive | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [contextPreview, setContextPreview] = useState<string>("");
  const [showPreview, setShowPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [changesSaveState, setChangesSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Load hive + targets. Called on mount and after any mutation.
  const reload = useCallback(async () => {
    const [hiveRes, targetsRes] = await Promise.all([
      fetch(`/api/hives/${id}`).then(r => r.json()),
      fetch(`/api/hives/${id}/targets`).then(r => r.json()),
    ]);
    setHive(hiveRes.data ?? null);
    setTargets(targetsRes.data || []);
  }, [id]);

  useEffect(() => {
    reload();
  // reload is stable for a given id — re-run only when id changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const patchHive = async (patch: Partial<Pick<Hive, "name" | "description" | "mission">>) => {
    const res = await fetch(`/api/hives/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) reload();
  };

  const addTarget = async () => {
    await fetch(`/api/hives/${id}/targets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New target" }),
    });
    reload();
  };

  const updateTarget = async (targetId: string, patch: Record<string, unknown>) => {
    await fetch(`/api/hives/${id}/targets/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    reload();
  };

  const deleteTarget = async (targetId: string) => {
    if (!confirm("Delete this target? Use 'Achieved' or 'Abandoned' status for lifecycle changes.")) return;
    await fetch(`/api/hives/${id}/targets/${targetId}`, { method: "DELETE" });
    reload();
  };

  const moveTarget = async (targetId: string, direction: "up" | "down") => {
    const open = targets.filter(t => t.status === "open");
    const idx = open.findIndex(t => t.id === targetId);
    if (idx < 0) return;
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= open.length) return;
    await Promise.all([
      updateTarget(targetId, { sort_order: open[swapWith].sortOrder }),
      updateTarget(open[swapWith].id, { sort_order: open[idx].sortOrder }),
    ]);
  };

  const loadPreview = async () => {
    const res = await fetch(`/api/hives/${id}/context-preview`);
    if (res.ok) {
      const body = await res.json();
      setContextPreview(body.data?.block ?? "");
    }
    setShowPreview(true);
  };

  if (!hive) return <p className="text-amber-600/70 dark:text-amber-400/60">Loading…</p>;

  const openTargets = targets.filter(t => t.status === "open");
  const historyTargets = targets.filter(t => t.status !== "open");

  const renderTarget = (t: Target, i: number, isOpen: boolean) => {
    const muted = t.status !== "open";
    const titlePrefix = t.status === "achieved" ? "✓ " : "";
    const titleClass = t.status === "abandoned" ? "line-through" : "";
    return (
      <div key={t.id} className={`space-y-3 rounded-md border p-4 ${muted ? "opacity-60" : ""}`}>
        <div className="flex items-center gap-2">
          {titlePrefix && <span className="text-sm text-green-600 dark:text-green-400">{titlePrefix}</span>}
          <input
            defaultValue={t.title}
            onBlur={e => updateTarget(t.id, { title: e.target.value })}
            className={`flex-1 rounded-md border px-3 py-2 text-sm dark:bg-zinc-800 ${titleClass}`}
            placeholder="Target title"
          />
          <select
            value={t.status}
            onChange={e => updateTarget(t.id, { status: e.target.value })}
            className="cursor-pointer rounded-md border px-2 py-2 text-sm dark:bg-zinc-800"
          >
            <option value="open">Open</option>
            <option value="achieved">Achieved</option>
            <option value="abandoned">Abandoned</option>
          </select>
          {isOpen && (
            <>
              <button
                onClick={() => moveTarget(t.id, "up")}
                disabled={i === 0}
                className="cursor-pointer rounded-md border px-2 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800"
                aria-label="Move up"
              >↑</button>
              <button
                onClick={() => moveTarget(t.id, "down")}
                disabled={i === openTargets.length - 1}
                className="cursor-pointer rounded-md border px-2 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800"
                aria-label="Move down"
              >↓</button>
            </>
          )}
          <button
            onClick={() => deleteTarget(t.id)}
            className="cursor-pointer rounded-md border px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            Delete
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <input
            defaultValue={t.targetValue ?? ""}
            onBlur={e => updateTarget(t.id, { target_value: e.target.value || null })}
            className="rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            placeholder="Target value (e.g. $50k/mo)"
          />
          <input
            type="date"
            defaultValue={t.deadline ? String(t.deadline).slice(0, 10) : ""}
            onBlur={e => updateTarget(t.id, { deadline: e.target.value || null })}
            className="rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          />
        </div>
        <textarea
          defaultValue={t.notes ?? ""}
          onBlur={e => updateTarget(t.id, { notes: e.target.value || null })}
          rows={2}
          className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          placeholder="Notes"
        />
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="hive-honey-glow space-y-2">
        <input
          value={hive.name}
          onChange={e => setHive({ ...hive, name: e.target.value })}
          onBlur={() => patchHive({ name: hive.name })}
          className="w-full rounded-md bg-transparent px-1 -mx-1 text-2xl font-semibold text-amber-900 outline-none focus:ring-2 focus:ring-amber-300 dark:text-amber-50 dark:focus:ring-amber-400/50"
        />
        <div className="flex flex-wrap gap-2 text-xs text-amber-700/70 dark:text-amber-600/70">
          <span className="rounded-full bg-amber-100/60 px-2 py-0.5 font-mono text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">{hive.slug}</span>
          <span className="rounded-full bg-amber-100/60 px-2 py-0.5 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">{hive.type}</span>
          <span>created {new Date(hive.createdAt).toLocaleDateString()}</span>
        </div>
        <HiveSectionNav hiveId={id} />
      </div>

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Description</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">One-line tagline — shows on hive cards and lists.</p>
        </div>
        <textarea
          rows={2}
          value={hive.description ?? ""}
          onChange={e => setHive({ ...hive, description: e.target.value })}
          className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
        />
      </section>

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Mission</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            The overarching purpose of this hive — why it exists and what success looks like.
            Every agent working in this hive reads this before starting. Capped at 500 words in the rendered agent context.
          </p>
        </div>
        <textarea
          rows={10}
          value={hive.mission ?? ""}
          onChange={e => setHive({ ...hive, mission: e.target.value })}
          className="w-full rounded-md border px-3 py-2 font-mono text-sm dark:bg-zinc-800"
          placeholder="# Mission&#10;&#10;What this hive is here to accomplish…"
        />
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={async () => {
            setChangesSaveState("saving");
            const res = await fetch(`/api/hives/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                description: hive.description ?? "",
                mission: hive.mission ?? "",
              }),
            });
            if (res.ok) {
              setChangesSaveState("saved");
              reload();
              setTimeout(() => setChangesSaveState("idle"), 2000);
            } else {
              setChangesSaveState("error");
              setTimeout(() => setChangesSaveState("idle"), 4000);
            }
          }}
          disabled={changesSaveState === "saving"}
          className="cursor-pointer rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {changesSaveState === "saving" ? "Saving…" : "Save changes"}
        </button>
        {changesSaveState === "saved" && (
          <span className="text-sm text-green-600 dark:text-green-400">✓ Saved</span>
        )}
        {changesSaveState === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400">Save failed — check console</span>
        )}
      </div>

      <section className="space-y-4 rounded-lg border p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Targets</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Only <span className="font-medium">Open</span> targets are injected into agent spawns.
              Achieved and abandoned targets stay here for history.
            </p>
          </div>
          <button
            onClick={addTarget}
            className="cursor-pointer shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            + Add target
          </button>
        </div>

        <div className="space-y-3">
          {openTargets.length === 0 && <p className="text-sm text-zinc-400">No open targets yet.</p>}
          {openTargets.map((t, i) => renderTarget(t, i, true))}
        </div>

        {historyTargets.length > 0 && (
          <div className="mt-2 border-t pt-4">
            <button
              onClick={() => setShowHistory(v => !v)}
              className="cursor-pointer text-sm text-zinc-600 hover:underline dark:text-zinc-400"
            >
              {showHistory ? "Hide" : "Show"} achieved/abandoned ({historyTargets.length})
            </button>
            {showHistory && (
              <div className="mt-3 space-y-3">
                {historyTargets.map((t, i) => renderTarget(t, i, false))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border p-6">
        <button
          onClick={() => showPreview ? setShowPreview(false) : loadPreview()}
          className="cursor-pointer text-sm text-zinc-600 hover:underline dark:text-zinc-300"
        >
          {showPreview ? "Hide" : "Show"} agent context preview
        </button>
        {showPreview && (
          <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-4 text-xs font-mono text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            {contextPreview || "(empty)"}
          </pre>
        )}
      </section>
    </div>
  );
}
