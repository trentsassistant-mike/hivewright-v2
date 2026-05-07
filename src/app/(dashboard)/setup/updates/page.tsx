"use client";

import { useEffect, useState } from "react";

type UpdateStatus = {
  currentVersion: string;
  currentCommit: string | null;
  upstreamCommit: string | null;
  remoteUrl: string | null;
  branch: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  state: string;
  message: string;
};

type UpdatePlan = {
  allowed: boolean;
  commands: string[];
  message: string;
};

type UpdateResponse = {
  data?: {
    status: UpdateStatus;
    plan: UpdatePlan;
    started?: boolean;
    logPath?: string;
    warning?: string;
  };
  error?: string;
};

const panelClass =
  "rounded-lg border border-amber-200/55 bg-card/92 p-4 shadow-[0_18px_55px_rgba(62,43,15,0.08)] dark:border-white/[0.08] dark:bg-card/82 dark:shadow-black/20";
const primaryButtonClass =
  "rounded-md bg-amber-300 px-4 py-2 text-sm font-medium text-zinc-950 shadow-[0_10px_24px_rgba(229,154,27,0.16)] transition-colors hover:bg-amber-200 focus-visible:ring-2 focus-visible:ring-amber-500/45 disabled:opacity-50 dark:bg-amber-300 dark:text-zinc-950 dark:hover:bg-amber-200";
const secondaryButtonClass =
  "rounded-md border border-amber-200/70 px-4 py-2 text-sm transition-colors hover:bg-amber-100/70 focus-visible:ring-2 focus-visible:ring-amber-500/45 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]";

function shortSha(sha: string | null) {
  return sha ? sha.slice(0, 12) : "unknown";
}

export default function UpdatesPage() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/system/update", { cache: "no-store" });
      const body = await res.json() as UpdateResponse;
      if (!res.ok || !body.data) throw new Error(body.error ?? "Failed to load update status");
      setStatus(body.data.status);
      setPlan(body.data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function startUpdate() {
    setStarting(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restart: true }),
      });
      const body = await res.json() as UpdateResponse;
      if (!res.ok || !body.data) throw new Error(body.error ?? "Failed to start update");
      setResult(
        body.data.logPath
          ? `Update started. Log: ${body.data.logPath}`
          : "Update started.",
      );
      setStatus(body.data.status);
      setPlan(body.data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">HiveWright Updates</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Check the installed version, compare it with the configured Git remote, and start a safe self-hosted update.
        </p>
      </div>

      <section className={panelClass}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Installed version</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Updates use fast-forward Git pulls only. Local changes block automatic updates.
            </p>
          </div>
          <button className={secondaryButtonClass} onClick={loadStatus} disabled={loading || starting}>
            {loading ? "Checking…" : "Check for updates"}
          </button>
        </div>

        {status && (
          <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Version</dt>
              <dd className="font-medium">{status.currentVersion}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">State</dt>
              <dd className="font-medium">{status.state}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Branch</dt>
              <dd className="font-medium">{status.branch ?? "not configured"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Remote</dt>
              <dd className="break-all font-medium">{status.remoteUrl ?? "not configured"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Current commit</dt>
              <dd className="font-mono text-xs">{shortSha(status.currentCommit)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Upstream commit</dt>
              <dd className="font-mono text-xs">{shortSha(status.upstreamCommit)}</dd>
            </div>
          </dl>
        )}

        {status && <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">{status.message}</p>}
        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {result && <p className="mt-4 text-sm text-green-700 dark:text-green-400">{result}</p>}
      </section>

      <section className={panelClass}>
        <h2 className="text-sm font-semibold">Update plan</h2>
        <p className="mt-1 text-xs text-zinc-500">
          The terminal equivalent is `npm run hivewright:update -- --apply --yes --restart`.
        </p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {(plan?.commands ?? []).map((command) => <li key={command}>{command}</li>)}
          {plan && plan.commands.length === 0 && <li>No update commands are currently allowed.</li>}
        </ol>
        {plan && <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">{plan.message}</p>}
        <button
          className={`${primaryButtonClass} mt-4`}
          onClick={startUpdate}
          disabled={starting || loading || !plan?.allowed || !status?.updateAvailable}
        >
          {starting ? "Starting update…" : "Update HiveWright"}
        </button>
      </section>
    </div>
  );
}
