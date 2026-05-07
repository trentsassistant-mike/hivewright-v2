"use client";

import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

type Project = {
  id: string;
  slug: string;
  name: string;
  workspacePath: string | null;
  gitRepo: boolean;
  createdAt: string;
};

export default function ProjectsPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New project form
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetch(`/api/projects?hiveId=${selected.id}`)
      .then((r) => r.json())
      .then((body) => setProjects(body.data ?? []))
      .catch(() => setError("Failed to fetch projects"))
      .finally(() => setLoading(false));
  }, [selected]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !newSlug.trim() || !newName.trim()) return;

    setCreating(true);
    setCreateError(null);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, slug: newSlug.trim(), name: newName.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create project");
      }

      const data = await res.json();
      const created = data.data ?? data;
      setProjects((prev) => [created, ...prev]);
      setNewSlug("");
      setNewName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Projects</h1>

      {/* New project form */}
      <form onSubmit={handleCreate} className="rounded-lg border p-4 space-y-3 bg-white dark:bg-zinc-900">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">New Project</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1 space-y-1">
            <label htmlFor="project-slug" className="block text-xs text-zinc-500">
              Slug
            </label>
            <input
              id="project-slug"
              type="text"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="my-project"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          <div className="flex-1 space-y-1">
            <label htmlFor="project-name" className="block text-xs text-zinc-500">
              Name
            </label>
            <input
              id="project-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="My Project"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={creating || !newSlug.trim() || !newName.trim()}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors sm:w-auto"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
        {createError && (
          <p className="text-sm text-red-600 dark:text-red-400">{createError}</p>
        )}
      </form>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Projects table */}
      {loading ? (
        <p className="text-sm text-zinc-400">Loading projects...</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-zinc-500">Name</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-500">Slug</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-500">Path</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-500">Git</th>
                <th className="px-4 py-3 text-left font-medium text-zinc-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {projects.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    No projects yet. Create one above.
                  </td>
                </tr>
              ) : (
                projects.map((project) => (
                  <tr key={project.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      {project.name}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {project.slug}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 font-mono text-xs">
                      {project.workspacePath ?? "-"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          project.gitRepo
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
                            : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                        }`}
                      >
                        {project.gitRepo ? "Yes" : "No"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      {new Date(project.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
