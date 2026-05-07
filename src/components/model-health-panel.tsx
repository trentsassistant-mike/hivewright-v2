"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ModelHealthRow = {
  id: string;
  provider: string;
  adapterType: string;
  modelId: string;
  credentialName: string | null;
  enabled: boolean;
  fallbackPriority: number;
  status: string;
  lastProbedAt: string | null;
  nextProbeAt: string | null;
  freshness?: "unknown" | "fresh" | "due";
  probeMode?: "automatic" | "on_demand";
  latencyMs: number | null;
  failureClass: string | null;
  failureMessage: string | null;
};

type ModelHealthResponse = {
  rows: ModelHealthRow[];
};

type ProbeResult = {
  probed: number;
  healthy: number;
  unhealthy: number;
};

type SyncResult = {
  upserted: number;
  skipped: number;
};

export function ModelHealthPanel({
  hiveId,
  hiveName,
}: {
  hiveId: string;
  hiveName: string;
}) {
  const [rows, setRows] = useState<ModelHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<ProbeResult | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/model-health?hiveId=${hiveId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const data = body.data as ModelHealthResponse;
      setRows(data.rows ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hiveId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runProbes() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/model-health/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId, includeFresh: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setLastRun(body.data.result as ProbeResult);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function syncModels() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/model-health/sync-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setLastSync(body.data.result as SyncResult);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Model Health</h2>
          <div className="text-xs text-zinc-500">{hiveName}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={syncModels}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
            {syncing ? "Syncing..." : "Sync configured models"}
          </button>
          <button
            type="button"
            onClick={runProbes}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <RefreshCw className={`size-3.5 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
            {running ? "Running..." : "Run health probes"}
          </button>
        </div>
      </div>

      {lastSync && (
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          Last sync: {lastSync.upserted} models synced, {lastSync.skipped} skipped
        </div>
      )}
      {lastRun && (
        <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          Last probe run: {lastRun.probed} probed, {lastRun.healthy} healthy, {lastRun.unhealthy} unhealthy
        </div>
      )}
      {error && (
        <div className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full text-xs">
          <thead className="bg-zinc-50 text-left text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-2 py-2">Provider</th>
              <th className="px-2 py-2">Adapter</th>
              <th className="px-2 py-2">Model</th>
              <th className="px-2 py-2">Credential</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Freshness</th>
              <th className="px-2 py-2">Latency</th>
              <th className="px-2 py-2">Last probe</th>
              <th className="px-2 py-2">Next probe</th>
              <th className="px-2 py-2">Failure</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="px-2 py-2">{row.provider}</td>
                <td className="px-2 py-2 font-mono">{row.adapterType}</td>
                <td className="px-2 py-2 font-mono">{row.modelId}</td>
                <td className="px-2 py-2">{row.credentialName ?? "runtime"}</td>
                <td className="px-2 py-2">
                  <span className={statusClass(row.status)}>{row.status}</span>
                </td>
                <td className="px-2 py-2">{formatFreshness(row)}</td>
                <td className="px-2 py-2">{row.latencyMs === null ? "-" : `${row.latencyMs} ms`}</td>
                <td className="px-2 py-2">{formatDate(row.lastProbedAt)}</td>
                <td className="px-2 py-2">{formatDate(row.nextProbeAt)}</td>
                <td className="px-2 py-2">{row.failureClass ?? row.failureMessage ?? "-"}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td className="px-2 py-4 text-zinc-500" colSpan={10}>
                  No enabled models registered for health probes.
                </td>
              </tr>
            )}
            {loading && rows.length === 0 && (
              <tr>
                <td className="px-2 py-4 text-zinc-500" colSpan={10}>
                  Loading model health...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function statusClass(status: string) {
  switch (status) {
    case "healthy":
      return "text-emerald-600 dark:text-emerald-400";
    case "unhealthy":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-zinc-500";
  }
}

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatFreshness(row: Pick<ModelHealthRow, "freshness" | "probeMode">) {
  const freshness = row.freshness ?? "unknown";
  const mode = row.probeMode === "on_demand" ? "on-demand" : "automatic";
  return `${freshness} · ${mode}`;
}
