"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type RunsTableBadgeTone = "neutral" | "amber" | "green" | "red" | "blue";
export type RunsTableStatusTone = "neutral" | "active" | "success" | "warning" | "danger";

export type RunsTableBadge = {
  label: string | number;
  tone?: RunsTableBadgeTone;
  title?: string;
};

export type RunsTableMetadata = {
  label: string;
  value: ReactNode;
};

export type RunsTableRow = {
  id: string;
  title: ReactNode;
  href?: string;
  status?: RunsTableBadge | string | number | null;
  statusTone?: RunsTableStatusTone;
  role?: string | null;
  priority?: RunsTableBadge | string | number | null;
  createdAt?: string | Date | null;
  primaryMeta?: RunsTableMetadata[];
  secondaryMeta?: RunsTableMetadata[];
  meta?: ReactNode;
  action?: ReactNode;
  actions?: ReactNode;
  expandedContent?: ReactNode;
  ariaLabel?: string;
  onClick?: () => void;
  muted?: boolean;
  rowClassName?: string;
};

type RunsTableProps = {
  rows: RunsTableRow[];
  loading?: boolean;
  error?: ReactNode;
  emptyState?: ReactNode;
  emptyLabel?: ReactNode;
  loadingState?: ReactNode;
  className?: string;
  ariaLabel?: string;
  columns?: {
    title?: string;
    primaryMeta?: string;
    status?: string;
    priority?: string;
    secondaryMeta?: string;
  };
};

const badgeToneClass: Record<RunsTableBadgeTone, string> = {
  neutral:
    "border-zinc-300/70 bg-zinc-100 text-zinc-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-zinc-300",
  amber:
    "border-amber-300/70 bg-amber-100 text-amber-950 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100",
  green:
    "border-emerald-300/70 bg-emerald-100 text-emerald-800 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-100",
  red:
    "border-red-300/80 bg-red-100 text-red-800 dark:border-red-300/20 dark:bg-red-300/10 dark:text-red-100",
  blue:
    "border-sky-300/70 bg-sky-100 text-sky-800 dark:border-sky-300/20 dark:bg-sky-300/10 dark:text-sky-100",
};

const statusToneMap: Record<RunsTableStatusTone, RunsTableBadgeTone> = {
  neutral: "neutral",
  active: "amber",
  success: "green",
  warning: "amber",
  danger: "red",
};

function normalizeBadge(
  badge: RunsTableBadge | string | number | null | undefined,
  tone: RunsTableBadgeTone = "neutral",
) {
  if (badge === null || badge === undefined) return undefined;
  if (typeof badge === "object" && "label" in badge) return badge;
  return { label: badge, tone };
}

function formatDate(value: RunsTableRow["createdAt"]) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

function RunsTableBadgeView({ badge }: { badge: RunsTableBadge }) {
  return (
    <Badge
      variant="outline"
      title={badge.title}
      className={cn("capitalize", badgeToneClass[badge.tone ?? "neutral"])}
    >
      {badge.label}
    </Badge>
  );
}

function MetadataList({ items }: { items?: RunsTableMetadata[] }) {
  if (!items?.length) return null;

  return (
    <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[0.75rem] leading-5 text-zinc-500 dark:text-zinc-400">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 items-center gap-1.5">
          <dt className="shrink-0 text-zinc-500/80 dark:text-zinc-500">{item.label}</dt>
          <dd className="min-w-0 truncate font-medium text-zinc-700 dark:text-zinc-300">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StateBlock({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
      {children}
    </div>
  );
}

export function RunsTable({
  rows,
  loading = false,
  error,
  emptyState = "No runs found.",
  emptyLabel,
  loadingState = "Loading runs...",
  className,
  ariaLabel = "Runs table",
  columns,
}: RunsTableProps) {
  const columnLabels = {
    title: columns?.title ?? "Run",
    primaryMeta: columns?.primaryMeta ?? "Role",
    status: columns?.status ?? "Status",
    priority: columns?.priority ?? "Priority",
    secondaryMeta: columns?.secondaryMeta ?? "Created",
  };

  if (loading) {
    return (
      <section
        aria-label={ariaLabel}
        className={cn(
          "overflow-hidden rounded-lg border border-white/[0.08] bg-black/[0.14]",
          className,
        )}
      >
        <StateBlock>{loadingState}</StateBlock>
      </section>
    );
  }

  if (error) {
    return (
      <section
        aria-label={ariaLabel}
        className={cn(
          "overflow-hidden rounded-lg border border-red-400/20 bg-red-950/10",
          className,
        )}
      >
        <StateBlock>{error}</StateBlock>
      </section>
    );
  }

  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        "overflow-hidden rounded-lg border border-amber-200/70 bg-amber-50/65 shadow-sm shadow-amber-950/5 dark:border-white/[0.08] dark:bg-white/[0.025] dark:shadow-black/20",
        className,
      )}
    >
      <div className="hidden min-h-9 grid-cols-[minmax(14rem,1fr)_minmax(7rem,0.5fr)_6rem_5rem_minmax(6.5rem,0.45fr)] items-center gap-3 border-b border-amber-200/70 bg-amber-100/55 px-4 text-[0.7rem] font-semibold uppercase text-amber-950/55 dark:border-white/[0.07] dark:bg-white/[0.035] dark:text-zinc-500 lg:grid">
        <span>{columnLabels.title}</span>
        <span>{columnLabels.primaryMeta}</span>
        <span>{columnLabels.status}</span>
        <span>{columnLabels.priority}</span>
        <span>{columnLabels.secondaryMeta}</span>
      </div>

      {rows.length === 0 ? (
        <StateBlock>{emptyLabel ?? emptyState}</StateBlock>
      ) : (
        <div className="divide-y divide-amber-200/60 dark:divide-white/[0.06]">
          {rows.map((row) => {
            const status = normalizeBadge(
              row.status,
              statusToneMap[row.statusTone ?? "neutral"],
            );
            const priority = normalizeBadge(row.priority);
            const primaryMeta =
              row.primaryMeta ?? (row.role ? [{ label: "Role", value: row.role }] : undefined);
            const created = formatDate(row.createdAt);
            const secondaryMeta =
              row.secondaryMeta ?? (created ? [{ label: "Created", value: created }] : undefined);
            const action = row.actions ?? row.action;

            return (
              <article
                key={row.id}
                onClick={row.onClick}
                onKeyDown={(event) => {
                  if (!row.onClick) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    row.onClick();
                  }
                }}
                tabIndex={row.onClick ? 0 : undefined}
                role={row.onClick ? "button" : undefined}
                className={cn(
                  "transition-colors hover:bg-amber-100/55 focus-within:bg-amber-100/55 dark:hover:bg-white/[0.04] dark:focus-within:bg-white/[0.04]",
                  row.onClick && "cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-amber-400/55",
                  row.muted && "opacity-60",
                  row.rowClassName,
                )}
              >
                <div className="grid min-h-16 gap-3 px-4 py-3 lg:min-h-13 lg:grid-cols-[minmax(14rem,1fr)_minmax(7rem,0.5fr)_6rem_5rem_minmax(6.5rem,0.45fr)] lg:items-center lg:py-2.5">
                  <div className="min-w-0 space-y-1">
                    {row.href ? (
                      <Link
                        href={row.href}
                        aria-label={row.ariaLabel}
                        className="block truncate text-sm font-semibold text-amber-950 underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-amber-400/60 dark:text-amber-100"
                      >
                        {row.title}
                      </Link>
                    ) : (
                      <div className="truncate text-sm font-semibold text-foreground">
                        {row.title}
                      </div>
                    )}
                    {row.meta ? (
                      <div className="truncate text-xs text-amber-900/60 dark:text-zinc-500">
                        {row.meta}
                      </div>
                    ) : null}
                    <div className="lg:hidden">
                      <MetadataList items={primaryMeta} />
                    </div>
                  </div>

                  <div className="hidden min-w-0 lg:block">
                    <MetadataList items={primaryMeta} />
                  </div>

                  <div className="flex min-w-0 flex-wrap items-center gap-2 lg:block">
                    {status ? <RunsTableBadgeView badge={status} /> : null}
                    {priority ? (
                      <span className="lg:hidden">
                        <RunsTableBadgeView badge={priority} />
                      </span>
                    ) : null}
                  </div>

                  <div className="hidden lg:block">
                    {priority ? <RunsTableBadgeView badge={priority} /> : null}
                  </div>

                  <div className="min-w-0">
                    <MetadataList items={secondaryMeta} />
                    {action ? <div className="mt-2 lg:mt-1">{action}</div> : null}
                  </div>
                </div>
                {row.expandedContent ? (
                  <div className="px-4 pb-4">{row.expandedContent}</div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
