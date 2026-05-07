"use client";

import { useEffect, useState } from "react";

type AttachmentSource = "task" | "goal" | "idea";

type AttachmentRow = {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  source?: AttachmentSource;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function endpointFor(scope: Exclude<AttachmentSource, "idea">, id: string) {
  if (scope === "task") return `/api/tasks/${id}/attachments`;
  return `/api/goals/${id}/attachments`;
}

export function AttachmentsPanel({
  scope,
  id,
  hiveId,
}: {
  scope: AttachmentSource;
  id: string;
  hiveId?: string;
}) {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const url = scope === "idea"
          ? `/api/hives/${hiveId}/ideas/${id}/attachments`
          : endpointFor(scope, id);
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          if (active) {
            setRows([]);
            setLoaded(true);
          }
          return;
        }

        const payload = await response.json();
        if (!active) return;

        setRows((payload.data ?? []) as AttachmentRow[]);
        setLoaded(true);
      } catch {
        if (!active) return;
        setRows([]);
        setLoaded(true);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [scope, id, hiveId]);

  if (!loaded || rows.length === 0) return null;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Attachments
      </h2>
      <ul className="space-y-2">
        {rows.map((attachment) => {
          const isImage = attachment.mimeType?.startsWith("image/") ?? false;
          const downloadUrl = `/api/attachments/${attachment.id}/download`;
          return (
            <li
              key={attachment.id}
              className="flex items-center gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900"
            >
              {isImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={downloadUrl}
                  alt={attachment.filename}
                  className="h-12 w-12 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-zinc-200 font-mono text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {(attachment.filename.split(".").pop() ?? "FILE").toUpperCase().slice(0, 4)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <a
                  href={downloadUrl}
                  className="block truncate text-sm font-medium text-blue-700 hover:underline dark:text-blue-400"
                >
                  {attachment.filename}
                </a>
                <p className="text-xs text-zinc-500">
                  {formatSize(Number(attachment.sizeBytes))}
                  {scope === "task" && attachment.source === "goal"
                    ? " · inherited from goal"
                    : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
