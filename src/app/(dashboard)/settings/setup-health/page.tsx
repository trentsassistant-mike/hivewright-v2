"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, CircleDashed, Clock3 } from "lucide-react";
import { useHiveContext } from "@/components/hive-context";
import type { SetupHealthRow, SetupHealthStatus } from "@/setup-health/status";

type SetupHealthResponse = {
  hiveId: string;
  rows: SetupHealthRow[];
  sources: Record<string, string>;
};

const statusStyles: Record<SetupHealthStatus, string> = {
  ready: "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200",
  needs_attention: "border-red-300/70 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200",
  pending: "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200",
  not_set_up: "border-zinc-300/70 bg-zinc-50 text-zinc-700 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-zinc-300",
};

const statusIcon = {
  ready: CheckCircle2,
  needs_attention: AlertCircle,
  pending: Clock3,
  not_set_up: CircleDashed,
};

export default function SetupHealthPage() {
  const { selected, hives, loading: hivesLoading } = useHiveContext();
  const hive = selected ?? hives[0] ?? null;
  const [health, setHealth] = useState<SetupHealthResponse | null>(null);
  const [error, setError] = useState<{ hiveId: string; message: string } | null>(null);

  useEffect(() => {
    if (!hive?.id) return;

    const controller = new AbortController();
    fetch(`/api/setup-health?hiveId=${hive.id}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Could not load setup health.");
        setHealth(body.data ?? null);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") {
          setHealth(null);
          setError({
            hiveId: hive.id,
            message: err instanceof Error ? err.message : "Could not load setup health.",
          });
        }
      });

    return () => controller.abort();
  }, [hive?.id]);

  const rows = useMemo(
    () => (health && hive?.id && health.hiveId === hive.id ? health.rows ?? [] : []),
    [health, hive],
  );
  const readyCount = useMemo(
    () => rows.filter((row) => row.status === "ready").length,
    [rows],
  );
  const errorMessage = error && hive?.id && error.hiveId === hive.id ? error.message : null;
  const loading = Boolean(hive?.id) && !errorMessage && health?.hiveId !== hive?.id;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Settings</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Setup health</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              A plain-English checklist for whether this hive is ready to run work reliably.
            </p>
          </div>
          {rows.length > 0 ? (
            <p className="rounded-md border border-amber-200/70 bg-card px-3 py-2 text-sm text-muted-foreground dark:border-white/[0.08]">
              {readyCount} of {rows.length} ready
            </p>
          ) : null}
        </div>
      </header>

      {!hive && !hivesLoading ? (
        <section className="rounded-lg border border-dashed p-5">
          <h2 className="text-lg font-medium">No hive selected</h2>
          <p className="mt-1 text-sm text-muted-foreground">Create or select a hive before checking setup health.</p>
          <Link className="mt-4 inline-flex rounded-md border px-3 py-2 text-sm hover:bg-accent" href="/hives">
            Choose hive
          </Link>
        </section>
      ) : null}

      {loading || hivesLoading ? (
        <section className="rounded-lg border p-5 text-sm text-muted-foreground">
          Checking setup health...
        </section>
      ) : null}

      {errorMessage ? (
        <section role="alert" className="rounded-lg border border-red-300 bg-red-50 p-5 text-sm text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200">
          {errorMessage}
        </section>
      ) : null}

      {rows.length > 0 ? (
        <section className="overflow-hidden rounded-lg border border-amber-200/60 bg-card/92 shadow-[0_18px_55px_rgba(62,43,15,0.08)] dark:border-white/[0.08] dark:bg-card/82 dark:shadow-black/20">
          <div className="divide-y divide-amber-200/55 dark:divide-white/[0.08]">
            {rows.map((row) => {
              const Icon = statusIcon[row.status];
              return (
                <article key={row.key} className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{row.title}</h2>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyles[row.status]}`}>
                        <Icon className="size-3.5" aria-hidden="true" />
                        {row.statusLabel}
                      </span>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">{row.summary}</p>
                    {row.limitation ? (
                      <p className="text-xs leading-5 text-muted-foreground">{row.limitation}</p>
                    ) : null}
                  </div>
                  <Link
                    href={row.href}
                    className="inline-flex w-fit items-center justify-center rounded-md border border-amber-200/70 px-3 py-2 text-sm font-medium transition-colors hover:bg-amber-100/70 focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                  >
                    {row.hrefLabel}
                  </Link>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
