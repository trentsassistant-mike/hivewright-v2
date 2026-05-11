"use client";

import { useEffect, useRef, useState } from "react";
import { validateAttachmentFiles } from "@/attachments/constants";
import {
  AttachmentDropzone,
  type AttachmentFileEntry,
  createAttachmentFileEntries,
  revokeAttachmentFileEntries,
} from "@/components/attachment-dropzone";
import { useHiveContext } from "@/components/hive-context";

type Role = {
  slug: string;
  name: string;
};

type Project = {
  id: string;
  slug: string;
  name: string;
};

type WorkResult = {
  type: "task" | "goal";
  id: string;
  title: string;
};

export default function IntakePage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [roles, setRoles] = useState<Role[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assignedTo, setAssignedTo] = useState("");
  const [projectId, setProjectId] = useState("");
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<AttachmentFileEntry[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WorkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filesRef = useRef<AttachmentFileEntry[]>([]);

  useEffect(() => {
    fetch("/api/roles")
      .then((r) => r.json())
      .then((data) => {
        const list: Role[] = data.data ?? [];
        setRoles(list);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    setProjectId("");
    fetch(`/api/projects?hiveId=${selected.id}`)
      .then((r) => r.json())
      .then((data) => setProjects(data.data ?? []))
      .catch(() => setProjects([]));
  }, [selected]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    return () => {
      revokeAttachmentFileEntries(filesRef.current);
    };
  }, []);

  function addFiles(incoming: File[]) {
    setFileError(null);
    const validationError = validateAttachmentFiles([
      ...files.map((entry) => entry.file),
      ...incoming,
    ]);
    if (validationError) {
      setFileError(validationError);
      return;
    }

    const newEntries = createAttachmentFileEntries(incoming);
    setFiles((prev) => [...prev, ...newEntries]);
  }

  function removeFile(index: number) {
    setFiles((prev) => {
      const entry = prev[index];
      if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      return prev.filter((_, i) => i !== index);
    });
    setFileError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !input.trim()) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      let res: Response;

      if (files.length > 0) {
        const formData = new FormData();
        formData.append("hiveId", selected.id);
        formData.append("input", input.trim());
        if (assignedTo) formData.append("assignedTo", assignedTo);
        if (projectId) formData.append("projectId", projectId);
        files.forEach((entry) => formData.append("files", entry.file));
        res = await fetch("/api/work", { method: "POST", body: formData });
      } else {
        res = await fetch("/api/work", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hiveId: selected.id,
            input: input.trim(),
            assignedTo: assignedTo || undefined,
            projectId: projectId || undefined,
          }),
        });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to submit");
      }

      const data = await res.json();
      setResult(data.data ?? data);
      setInput("");
      revokeAttachmentFileEntries(files);
      setFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Outcome Intake</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Tell HiveWright the outcome you want, not the step-by-step method. The supervisor will decide whether this is a direct task or a goal, infer the right approach, and use approved procedures only when a mandatory process applies.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Hive
          </label>
          <p className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
            {selected.name}
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="project" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Project (optional)
          </label>
          <select
            id="project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.slug})
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="role" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Assign To (optional)
          </label>
          <select
            id="role"
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="">Auto-assign (let system decide)</option>
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name} ({r.slug})
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="input" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Desired outcome
          </label>
          <textarea
            id="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={6}
            placeholder="Example: Get three qualified leads for the roofing offer this week, using any approved sales procedures that apply."
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Attachments (optional)
          </label>
          <AttachmentDropzone
            files={files}
            error={fileError}
            disabled={loading}
            onAddFiles={addFiles}
            onRemoveFile={removeFile}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {loading ? "Submitting..." : "Submit"}
        </button>
      </form>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 space-y-1 dark:border-green-900 dark:bg-green-950">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            {result.type === "goal" ? "Goal created" : "Task created"}
          </p>
          <p className="text-sm text-green-700 dark:text-green-400">{result.title}</p>
          <a
            href={`/${result.type === "goal" ? "goals" : "tasks"}/${result.id}`}
            className="text-xs text-green-600 hover:underline dark:text-green-500"
          >
            View {result.type} &rarr;
          </a>
        </div>
      )}
    </div>
  );
}
