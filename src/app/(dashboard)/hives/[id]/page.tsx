"use client";
import { useEffect, useState, useCallback } from "react";
import type { FormEvent } from "react";
import { useParams } from "next/navigation";
import { HiveSectionNav } from "@/components/hive-section-nav";

interface Hive {
  id: string;
  slug: string;
  name: string;
  type: string;
  description: string | null;
  mission: string | null;
  softwareStack: string | null;
  workspacePath: string | null;
  aiBudget: {
    capCents: number;
    window: "daily" | "weekly" | "monthly" | "all_time";
  };
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
  const [uploadSaveState, setUploadSaveState] = useState<"idle" | "uploading" | "uploaded" | "error">("idle");
  const [selectedReferenceFile, setSelectedReferenceFile] = useState<File | null>(null);
  const [changesSaveState, setChangesSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [referenceTitle, setReferenceTitle] = useState("");
  const [budgetSaveState, setBudgetSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load hive + targets. Called on mount and after any mutation.
  const reload = useCallback(async () => {
    setLoadError(null);
    const readJson = async (res: Response) => {
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed with ${res.status}`);
      }
      return body;
    };

    try {
      const [hiveRes, targetsRes] = await Promise.all([
        fetch(`/api/hives/${id}`).then(readJson),
        fetch(`/api/hives/${id}/targets`).then(readJson),
      ]);
      setHive(hiveRes.data ?? null);
      setTargets(targetsRes.data || []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load hive");
    }
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

  const saveBudget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hive) return;
    const form = new FormData(event.currentTarget);
    const dollars = Number(form.get("aiBudgetDollars"));
    const window = String(form.get("aiBudgetWindow") ?? hive.aiBudget.window);

    if (!Number.isFinite(dollars) || dollars < 0) {
      setBudgetSaveState("error");
      setTimeout(() => setBudgetSaveState("idle"), 4000);
      return;
    }

    setBudgetSaveState("saving");
    const res = await fetch(`/api/hives/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aiBudget: {
          capCents: Math.round(dollars * 100),
          window,
        },
      }),
    });

    if (res.ok) {
      setBudgetSaveState("saved");
      await reload();
      setTimeout(() => setBudgetSaveState("idle"), 2000);
    } else {
      setBudgetSaveState("error");
      setTimeout(() => setBudgetSaveState("idle"), 4000);
    }
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
  const uploadReferenceDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedReferenceFile) {
      setUploadSaveState("error");
      setTimeout(() => setUploadSaveState("idle"), 3000);
      return;
    }
    const form = new FormData();
    form.append("file", selectedReferenceFile);
    if (referenceTitle.trim()) form.append("title", referenceTitle.trim());
    setUploadSaveState("uploading");
    const res = await fetch(`/api/hives/${id}/files?category=reference-documents`, {
      method: "POST",
      body: form,
    });
    if (res.ok) {
      setUploadSaveState("uploaded");
      setSelectedReferenceFile(null);
      setReferenceTitle("");
      const input = event.currentTarget.querySelector<HTMLInputElement>("input[type='file']");
      if (input) input.value = "";
      setTimeout(() => setUploadSaveState("idle"), 2500);
    } else {
      setUploadSaveState("error");
      setTimeout(() => setUploadSaveState("idle"), 5000);
    }
  };


  if (!hive) {
    return (
      <p className={loadError ? "text-red-600 dark:text-red-400" : "text-amber-600/70 dark:text-amber-400/60"}>
        {loadError ?? "Loading…"}
      </p>
    );
  }

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
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Budget controls</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Hive-level overall cap for billable AI spend. Subscription/OAuth token usage is excluded from this budget.
          </p>
        </div>
        <form onSubmit={saveBudget} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Hive budget cap (USD)</span>
            <input
              name="aiBudgetDollars"
              type="number"
              min="0"
              step="1"
              defaultValue={Math.round((hive.aiBudget?.capCents ?? 0) / 100)}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Time window</span>
            <select
              name="aiBudgetWindow"
              defaultValue={hive.aiBudget?.window ?? "all_time"}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="all_time">All time</option>
            </select>
          </label>
          <button
            disabled={budgetSaveState === "saving"}
            className="cursor-pointer rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-wait disabled:opacity-50"
          >
            {budgetSaveState === "saving" ? "Saving…" : "Save budget"}
          </button>
        </form>
        <div className="flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>Current cap: ${((hive.aiBudget?.capCents ?? 0) / 100).toFixed(2)}</span>
          <span>•</span>
          <span>Window: {(hive.aiBudget?.window ?? "all_time").replace("_", " ")}</span>
          {budgetSaveState === "saved" && <span className="text-green-600 dark:text-green-400">✓ Saved</span>}
          {budgetSaveState === "error" && <span className="text-red-600 dark:text-red-400">Save failed</span>}
        </div>
      </section>

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

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Reference documents</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Upload owner-approved rules, FAQs, cancellation policies, SOPs, and other source material.
            Uploaded files are listed in agent context so workers know where to look, but file contents are only opened when relevant. All files are visible under the Files tab.
          </p>
        </div>
        <form onSubmit={uploadReferenceDocument} className="space-y-3">
          <input
            value={referenceTitle}
            onChange={e => setReferenceTitle(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            placeholder="Optional title / label (e.g. Cancellation policy)"
          />
          <input
            type="file"
            onChange={e => setSelectedReferenceFile(e.target.files?.[0] ?? null)}
            className="block w-full cursor-pointer rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml,.pdf,.doc,.docx"
          />
          <div className="flex items-center gap-3">
            <button
              disabled={uploadSaveState === "uploading"}
              className="cursor-pointer rounded-md border px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-zinc-800"
            >
              {uploadSaveState === "uploading" ? "Uploading…" : "Upload reference document"}
            </button>
            {uploadSaveState === "uploaded" && <span className="text-sm text-green-600 dark:text-green-400">✓ Uploaded</span>}
            {uploadSaveState === "error" && <span className="text-sm text-red-600 dark:text-red-400">Upload failed</span>}
          </div>
        </form>
      </section>

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Software and systems used</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            List the apps, accounts, and operational systems this hive uses — e.g. Gmail, NewBook, Xero, Shopify.
            Agents receive this as reference context even before a connector exists.
          </p>
        </div>
        <textarea
          rows={5}
          value={hive.softwareStack ?? ""}
          onChange={e => setHive({ ...hive, softwareStack: e.target.value })}
          className="w-full rounded-md border px-3 py-2 font-mono text-sm dark:bg-zinc-800"
          placeholder="- Gmail: customer email&#10;- NewBook: bookings/PMS&#10;- ..."
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
                softwareStack: hive.softwareStack ?? "",
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
