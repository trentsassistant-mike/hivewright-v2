"use client";

import { useRef, useState } from "react";
import { MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_FILE_SIZE } from "@/attachments/constants";

export type AttachmentFileEntry = {
  file: File;
  objectUrl: string | null;
};

export function createAttachmentFileEntries(files: File[]): AttachmentFileEntry[] {
  return files.map((file) => ({
    file,
    objectUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
  }));
}

export function revokeAttachmentFileEntries(files: AttachmentFileEntry[]) {
  for (const entry of files) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentDropzone({
  files,
  error,
  disabled = false,
  onAddFiles,
  onRemoveFile,
}: {
  files: AttachmentFileEntry[];
  error: string | null;
  disabled?: boolean;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDragActive = !disabled && dragOver;

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragOver(false);
          onAddFiles(Array.from(event.dataTransfer.files));
        }}
        onClick={() => {
          if (!disabled) fileInputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-6 transition-colors ${
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer"
        } ${
          isDragActive
            ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950"
            : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600"
        }`}
      >
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          Drag files here or{" "}
          <span className="text-blue-600 dark:text-blue-400">choose files</span>
        </span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          Up to {MAX_ATTACHMENT_FILES} files · {formatSize(MAX_ATTACHMENT_FILE_SIZE)} each
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          onAddFiles(Array.from(event.target.files ?? []));
          event.currentTarget.value = "";
        }}
      />

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((entry, index) => (
            <li
              key={`${entry.file.name}-${entry.file.size}-${index}`}
              className="flex items-center gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900"
            >
              {entry.file.type.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={entry.objectUrl ?? ""}
                  alt={entry.file.name}
                  className="h-10 w-10 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-zinc-200 font-mono text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {(entry.file.name.split(".").pop() ?? "FILE").toUpperCase().slice(0, 4)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-800 dark:text-zinc-200">
                  {entry.file.name}
                </p>
                <p className="text-xs text-zinc-500">
                  {formatSize(entry.file.size)}
                </p>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemoveFile(index)}
                className="shrink-0 text-sm text-zinc-400 transition-colors hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`Remove ${entry.file.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
