"use client";
import { useEffect, useState } from "react";
import { ProvisionBadge } from "../../../components/provision-badge";
import type { ProvisionStatus } from "../../../provisioning/types";
import { RunsTable, type RunsTableRow } from "@/components/runs-table";
import { useHiveContext } from "@/components/hive-context";

interface Role {
  slug: string; name: string; department: string; type: string;
  recommendedModel: string | null; fallbackModel: string | null;
  adapterType: string;
  fallbackAdapterType: string | null;
  skills: string[]; active: boolean;
  toolsConfig: { mcps?: string[]; allowedTools?: string[] } | null;
  /** Max tasks of this role the dispatcher will run concurrently. */
  concurrencyLimit: number;
  provisionStatus: ProvisionStatus;
  /** Tasks currently pending or running for this role. */
  activeCount: number;
  /** Tasks actively running (not just queued) for this role. */
  runningCount: number;
}

interface McpCatalogEntry {
  slug: string;
  label: string;
  description: string;
  requiredEnv: string[];
  requiredEnvPresent: boolean;
}

interface ModelOption {
  id: string;
  alias: string | null;
}

interface SetupModel {
  adapterType: string;
  modelId: string;
  displayName?: string | null;
  hiveEnabled?: boolean | null;
}

const AUTO_MODEL_ROUTE = "auto";
const AUTO_MODEL_OPTION: ModelOption = { id: AUTO_MODEL_ROUTE, alias: "Auto" };
const MANUAL_ADAPTERS = ["claude-code", "codex", "gemini", "ollama"];
const ADAPTERS = [AUTO_MODEL_ROUTE, ...MANUAL_ADAPTERS];

const ANTHROPIC_MODELS = [
  "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7", "anthropic/claude-opus-4-6",
];
const CODEX_MODELS = [
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex",
];
const ALL_CLOUD_MODELS = [
  ...ANTHROPIC_MODELS,
  ...CODEX_MODELS,
  "mistral/mistral-large-latest",
  "mistral/mistral-ocr-latest",
  "openai/gpt-4o", "openai/gpt-4o-mini", "google/gemini-2.5-flash", "google/gemini-3.1-pro-preview", "google/gemini-3.1-pro-preview-customtools", "google/gemini-3.1-flash-lite-preview", "google/gemini-3-flash-preview",
];

const OLLAMA_MODELS_ENDPOINT = "/api/ollama/models";

function appendUniqueModel(models: ModelOption[], model: ModelOption): ModelOption[] {
  if (models.some((existing) => existing.id === model.id)) return models;
  return [...models, model];
}

export default function RolesPage() {
  const { selected: selectedHive } = useHiveContext();
  const [roles, setRoles] = useState<Role[]>([]);
  const [disabledRoles, setDisabledRoles] = useState<Role[]>([]);
  const [showDisabled, setShowDisabled] = useState(false);
  const [edits, setEdits] = useState<Record<string, { model?: string; adapter?: string; fallback?: string; fallbackAdapter?: string; concurrencyLimit?: number }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [togglingActive, setTogglingActive] = useState<string | null>(null);
  const [ollamaModels, setOllamaModels] = useState<ModelOption[]>([]);
  const [catalogModelsByAdapter, setCatalogModelsByAdapter] = useState<Record<string, ModelOption[]>>({});
  const [pulling, setPulling] = useState<Record<string, { percent?: number; message?: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [toolsEditor, setToolsEditor] = useState<string | null>(null); // slug of role being edited

  useEffect(() => {
    fetch("/api/roles")
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(b => setRoles(b.data || []))
      .catch(err => console.error("Failed to load roles:", err));

    // Fetch Ollama models from local GPU machine
    fetch(OLLAMA_MODELS_ENDPOINT)
      .then(r => r.json())
      .then(b => {
        if (b.data) {
          setOllamaModels(b.data.map((m: { id: string }) => ({ id: m.id, alias: null })));
        }
      })
      .catch(() => {});

    // Fetch MCP catalog so the per-role tool editor knows what's available.
    fetch("/api/mcp-catalog")
      .then(r => r.json())
      .then(b => { if (Array.isArray(b.data)) setMcpCatalog(b.data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedHive?.id) {
      setCatalogModelsByAdapter({});
      return;
    }
    let cancelled = false;
    setCatalogModelsByAdapter({});
    fetch(`/api/model-setup?hiveId=${encodeURIComponent(selectedHive.id)}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((body) => {
        if (cancelled) return;
        const models = Array.isArray(body.data?.models) ? body.data.models as SetupModel[] : [];
        const grouped: Record<string, ModelOption[]> = {};
        for (const model of models) {
          if (model.hiveEnabled !== true) continue;
          const option = {
            id: model.modelId,
            alias: model.displayName && model.displayName !== model.modelId ? model.displayName : null,
          };
          grouped[model.adapterType] = appendUniqueModel(grouped[model.adapterType] ?? [], option);
        }
        setCatalogModelsByAdapter(grouped);
      })
      .catch(() => {
        if (!cancelled) setCatalogModelsByAdapter({});
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHive?.id]);

  const saveToolsConfig = async (slug: string, mcps: string[] | null) => {
    setSaving(slug);
    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          toolsConfig: mcps === null ? null : { mcps },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRoles((prev) => prev.map((r) =>
        r.slug === slug
          ? { ...r, toolsConfig: mcps === null ? null : { ...r.toolsConfig, mcps } }
          : r,
      ));
      setToolsEditor(null);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [slug]: `Tools save failed: ${(err as Error).message}` }));
    } finally {
      setSaving(null);
    }
  };

  const cloudModels: ModelOption[] = ALL_CLOUD_MODELS.map(id => ({ id, alias: null }));

  /** Return models available for a given adapter type */
  const modelsForAdapter = (adapter: string, includeAuto = false): ModelOption[] => {
    if (adapter === AUTO_MODEL_ROUTE) return [AUTO_MODEL_OPTION];
    const withAuto = (models: ModelOption[]) => includeAuto ? [AUTO_MODEL_OPTION, ...models] : models;
    const catalogModels = catalogModelsByAdapter[adapter] ?? [];
    if (catalogModels.length > 0) return withAuto(catalogModels);
    switch (adapter) {
      case "claude-code":
        return withAuto(ANTHROPIC_MODELS.map(id => ({ id, alias: null })));
      case "codex":
        return withAuto(CODEX_MODELS.map(id => ({ id, alias: null })));
      case "ollama":
        return withAuto(ollamaModels);
      default:
        return withAuto([...cloudModels, ...ollamaModels]);
    }
  };

  const save = async (slug: string) => {
    const edit = edits[slug];
    if (!edit) return;
    setSaving(slug);

    await fetch("/api/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        recommendedModel: edit.model,
        adapterType: edit.adapter,
        fallbackModel: edit.fallback,
        fallbackAdapterType: edit.fallbackAdapter,
        concurrencyLimit: edit.concurrencyLimit,
      }),
    });

    setSaving(null);
    setEdits(prev => { const n = { ...prev }; delete n[slug]; return n; });
    await refreshRoles();
  };

  const refreshRoles = async () => {
    const res = await fetch("/api/roles");
    const body = await res.json();
    setRoles(body.data || []);
  };

  const refreshDisabledRoles = async () => {
    const res = await fetch("/api/roles?includeInactive=true");
    const body = await res.json();
    const all: Role[] = body.data || [];
    setDisabledRoles(all.filter((r) => !r.active));
  };

  const toggleActive = async (slug: string, currentlyActive: boolean) => {
    const action = currentlyActive ? "disable" : "enable";
    if (!window.confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} role "${slug}"?`)) return;
    setTogglingActive(slug);
    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, active: !currentlyActive }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrors((prev) => ({ ...prev, [slug]: body.error ?? `HTTP ${res.status}` }));
        return;
      }
      await refreshRoles();
      if (showDisabled) await refreshDisabledRoles();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [slug]: (err as Error).message }));
    } finally {
      setTogglingActive(null);
    }
  };

  async function provisionRole(slug: string) {
    setErrors((e) => ({ ...e, [slug]: "" }));
    setPulling((p) => ({ ...p, [slug]: { message: "starting" } }));
    const res = await fetch(`/api/roles/${slug}/provision`, { method: "POST" });
    if (!res.ok || !res.body) {
      setErrors((e) => ({ ...e, [slug]: `HTTP ${res.status}` }));
      setPulling((p) => { const n = { ...p }; delete n[slug]; return n; });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice(6)) as { phase: string; message?: string; percentComplete?: number; status?: { satisfied: boolean; reason?: string } };
          if (ev.phase === "pulling") {
            setPulling((p) => ({ ...p, [slug]: { percent: ev.percentComplete, message: ev.message } }));
          } else if (ev.phase === "done") {
            setPulling((p) => { const n = { ...p }; delete n[slug]; return n; });
            if (!ev.status?.satisfied) {
              setErrors((e) => ({ ...e, [slug]: ev.status?.reason ?? "provision failed" }));
            }
            await refreshRoles();
          }
        } catch { /* ignore */ }
      }
    }
  }

  async function provisionAll() {
    const fixable = roles.filter((r) => r.provisionStatus.fixable && !r.provisionStatus.satisfied);
    for (const r of fixable) {
      await provisionRole(r.slug);
    }
  }

  async function restartDispatcher() {
    if (!confirm("Restart the dispatcher?")) return;
    const res = await fetch("/api/dispatcher/restart", { method: "POST" });
    if (!res.ok) {
      alert(`Failed: ${await res.text()}`);
    } else {
      alert("Dispatcher restart requested.");
    }
  }

  const setEdit = (slug: string, field: "model" | "adapter" | "fallback" | "fallbackAdapter", value: string) => {
    setEdits(prev => ({ ...prev, [slug]: { ...prev[slug], [field]: value } }));
  };

  const setPrimaryAdapter = (slug: string, value: string) => {
    setEdits(prev => ({
      ...prev,
      [slug]: {
        ...prev[slug],
        adapter: value,
        ...(value === AUTO_MODEL_ROUTE ? { model: AUTO_MODEL_ROUTE } : {}),
      },
    }));
  };

  const setConcurrency = (slug: string, value: number) => {
    setEdits(prev => ({ ...prev, [slug]: { ...prev[slug], concurrencyLimit: value } }));
  };

  /** Show short model name: "claude-sonnet-4-6" instead of "anthropic/claude-sonnet-4-6" */
  const shortModel = (id: string | null | undefined, alias?: string | null) => {
    if (alias) return alias;
    if (!id) return "—";
    if (id === AUTO_MODEL_ROUTE) return "Auto";
    return id.includes("/") ? id.split("/")[1] : id;
  };

  const sortedRoles = [...roles].sort((a, b) => {
    if (a.type === "system" && b.type !== "system") return -1;
    if (a.type !== "system" && b.type === "system") return 1;
    return a.name.localeCompare(b.name);
  });

  const roleRows: RunsTableRow[] = [
    {
      id: "executive-assistant",
      title: "Executive Assistant",
      meta: <span className="font-mono">native Discord EA · per-hive</span>,
      status: { label: "ea", tone: "amber" },
      primaryMeta: [{ label: "Dept", value: "executive" }],
      secondaryMeta: [
        { label: "Adapter", value: "codex" },
        { label: "Model", value: <span className="font-mono">connector config</span> },
      ],
      actions: (
        <a href="/setup/connectors" className="text-xs text-blue-600 hover:underline">
          Configure in Connectors →
        </a>
      ),
    },
    ...sortedRoles.map((role): RunsTableRow => {
      const edit = edits[role.slug];
      const hasChanges = !!edit;
      const effectiveAdapter = edit?.adapter ?? role.adapterType;
      const availablePrimaryModels = modelsForAdapter(effectiveAdapter, true);
      const currentModel = edit?.model ?? role.recommendedModel ?? "";
      const primaryAdapter = edit?.adapter ?? role.adapterType;
      const currentFallbackAdapter = edit?.fallbackAdapter ?? role.fallbackAdapterType ?? "";
      const fallbackAdapter = edit && "fallbackAdapter" in edit
        ? edit.fallbackAdapter || primaryAdapter
        : role.fallbackAdapterType || primaryAdapter;
      const currentFallbackModel = edit?.fallback ?? role.fallbackModel ?? "";
      const fallbackModels = modelsForAdapter(fallbackAdapter);

      return {
        id: role.slug,
        title: (
          <span className="inline-flex items-center gap-1.5">
            <ProvisionBadge status={role.provisionStatus} /> {role.name}
          </span>
        ),
        meta: <span className="font-mono">{role.slug}</span>,
        status: { label: role.type, tone: role.type === "system" ? "blue" : "neutral" },
        primaryMeta: [{ label: "Dept", value: role.department }],
        secondaryMeta: [
          {
            label: "Status",
            value: (
              <span className={role.active ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}>
                {role.active ? "active" : "disabled"}
              </span>
            ),
          },
          { label: "Adapter", value: edit?.adapter ?? role.adapterType },
          { label: "Model", value: shortModel(edit?.model ?? role.recommendedModel) },
          {
            label: "Tasks",
            value: (
              <span title={`${role.runningCount} running · ${role.activeCount} pending+active total`}>
                {role.runningCount > 0
                  ? <span className="text-emerald-600 dark:text-emerald-400">{role.runningCount} running</span>
                  : <span className="text-zinc-400">{role.activeCount > 0 ? `${role.activeCount} queued` : "idle"}</span>
                }
              </span>
            ),
          },
        ],
        actions: (
          <div className="flex flex-wrap items-center gap-2">
            {hasChanges && (
              <button
                onClick={() => save(role.slug)}
                disabled={saving === role.slug}
                className="rounded bg-zinc-900 px-2 py-1 text-xs text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {saving === role.slug ? "..." : "Save"}
              </button>
            )}
            {role.provisionStatus.fixable && !role.provisionStatus.satisfied && !pulling[role.slug] && (
              <button
                onClick={() => provisionRole(role.slug)}
                className="rounded bg-yellow-500 px-2 py-1 text-xs text-white hover:bg-yellow-600"
              >
                Provision
              </button>
            )}
            {pulling[role.slug] && (
              <div className="text-xs">
                {pulling[role.slug].message} {pulling[role.slug].percent !== undefined ? `(${pulling[role.slug].percent}%)` : ""}
              </div>
            )}
            <button
              onClick={() => toggleActive(role.slug, role.active)}
              disabled={togglingActive === role.slug}
              aria-label={`Disable role ${role.name}`}
              className="rounded border border-zinc-300/60 px-2 py-1 text-xs text-zinc-500 hover:border-rose-400/60 hover:text-rose-400 disabled:opacity-50 dark:border-zinc-700/60 dark:text-zinc-400"
            >
              {togglingActive === role.slug ? "…" : "Disable"}
            </button>
            {errors[role.slug] && <div className="text-xs text-red-600">{errors[role.slug]}</div>}
          </div>
        ),
        expandedContent: (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="grid gap-1 text-xs text-zinc-500">
              Adapter
              <select
                value={effectiveAdapter}
                onChange={e => setPrimaryAdapter(role.slug, e.target.value)}
                className="w-full rounded border px-2 py-1 text-xs dark:bg-zinc-800"
              >
                {ADAPTERS.map(a => <option key={a} value={a}>{a === AUTO_MODEL_ROUTE ? "Auto" : a}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-zinc-500">
              Model
              <select
                value={currentModel}
                onChange={e => setEdit(role.slug, "model", e.target.value)}
                className="w-full rounded border px-2 py-1 text-xs dark:bg-zinc-800"
              >
                {currentModel && !availablePrimaryModels.some(m => m.id === currentModel) && (
                  <option value={currentModel}>{shortModel(currentModel)}</option>
                )}
                {availablePrimaryModels.map(m => (
                  <option key={m.id} value={m.id}>{shortModel(m.id, m.alias)}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-zinc-500">
              Fallback adapter
              <select
                value={currentFallbackAdapter}
                onChange={e => setEdit(role.slug, "fallbackAdapter", e.target.value)}
                className="w-full rounded border px-2 py-1 text-xs dark:bg-zinc-800"
              >
                <option value="">Same as primary ({primaryAdapter})</option>
                {MANUAL_ADAPTERS.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-zinc-500">
              Fallback model
              <select
                value={currentFallbackModel}
                onChange={e => setEdit(role.slug, "fallback", e.target.value)}
                className="w-full rounded border px-2 py-1 text-xs dark:bg-zinc-800"
              >
                <option value="">None</option>
                {currentFallbackModel && !fallbackModels.some(m => m.id === currentFallbackModel) && (
                  <option value={currentFallbackModel}>{shortModel(currentFallbackModel)}</option>
                )}
                {fallbackModels.map(m => (
                  <option key={m.id} value={m.id}>{shortModel(m.id, m.alias)}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-zinc-500">
              Concurrency
              <input
                type="number"
                min={1}
                step={1}
                value={edit?.concurrencyLimit ?? role.concurrencyLimit ?? 1}
                onChange={(e) => setConcurrency(role.slug, parseInt(e.target.value, 10) || 1)}
                className="w-24 rounded border px-2 py-1 text-xs text-center dark:bg-zinc-800"
                title="Max tasks of this role the dispatcher will run in parallel"
              />
            </label>
            <div className="grid gap-1 text-xs text-zinc-500 md:col-span-2 xl:col-span-3">
              Tools / MCPs
              {(() => {
                const grantedMcps = role.toolsConfig?.mcps;
                if (grantedMcps === undefined) {
                  return <button onClick={() => setToolsEditor(role.slug)} className="justify-self-start text-zinc-500 underline hover:text-blue-600">runtime default</button>;
                }
                if (grantedMcps.length === 0) {
                  return <button onClick={() => setToolsEditor(role.slug)} className="justify-self-start text-amber-700 underline hover:text-amber-900">none (locked)</button>;
                }
                return (
                  <button onClick={() => setToolsEditor(role.slug)} className="justify-self-start truncate text-blue-700 hover:underline">
                    {grantedMcps.join(", ")}
                  </button>
                );
              })()}
            </div>
          </div>
        ),
      };
    }),
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Roles & Agents</h1>
      <p className="text-sm text-zinc-500">Configure which adapter and model each role uses.</p>
      <DispatcherConcurrencyBanner />
      {selectedHive && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Model assignments</h2>
              <p className="text-xs text-zinc-500">
                Model availability, credentials, health, cost, quality, and routing are managed for {selectedHive.name} in setup.
              </p>
            </div>
            <a
              href="/setup/models"
              className="rounded bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Open Model Setup
            </a>
          </div>
        </section>
      )}
      <div className="flex flex-wrap gap-2 mb-4">
        {roles.some((r) => r.provisionStatus.fixable && !r.provisionStatus.satisfied) && (
          <button onClick={provisionAll} className="px-3 py-1.5 bg-yellow-500 text-white rounded">
            Provision All
          </button>
        )}
        <button onClick={restartDispatcher} className="px-3 py-1.5 bg-gray-200 rounded dark:bg-zinc-800 dark:text-zinc-200">
          Restart dispatcher
        </button>
        <button
          onClick={() => {
            const next = !showDisabled;
            setShowDisabled(next);
            if (next && disabledRoles.length === 0) void refreshDisabledRoles();
          }}
          className="px-3 py-1.5 rounded border border-zinc-300/60 text-xs text-zinc-500 hover:border-zinc-400 dark:border-zinc-700/60 dark:text-zinc-400 dark:hover:border-zinc-500"
        >
          {showDisabled ? "Hide disabled" : "Show disabled roles"}
        </button>
      </div>
      <RunsTable
        rows={roleRows}
        emptyState="No roles found."
        ariaLabel="Roles list"
        columns={{
          title: "Role",
          primaryMeta: "Dept",
          status: "Type",
          priority: "",
          secondaryMeta: "Runtime",
        }}
      />

      {showDisabled && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-500">Disabled roles</h2>
          {disabledRoles.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300/50 p-4 text-xs text-zinc-400 dark:border-zinc-700/40">
              No disabled roles found.
            </p>
          ) : (
            <RunsTable
              rows={disabledRoles.map((role): RunsTableRow => ({
                id: role.slug,
                title: <span className="text-zinc-500">{role.name}</span>,
                meta: <span className="font-mono text-zinc-500">{role.slug}</span>,
                status: { label: "disabled", tone: "neutral" },
                primaryMeta: [{ label: "Dept", value: role.department }],
                secondaryMeta: [
                  { label: "Adapter", value: role.adapterType },
                  { label: "Model", value: shortModel(role.recommendedModel) },
                ],
                muted: true,
                actions: (
                  <button
                    onClick={() => toggleActive(role.slug, false)}
                    disabled={togglingActive === role.slug}
                    aria-label={`Enable role ${role.name}`}
                    className="rounded border border-emerald-600/40 px-2 py-1 text-xs text-emerald-600 hover:bg-emerald-950/30 hover:text-emerald-400 disabled:opacity-50 dark:border-emerald-500/30 dark:text-emerald-400"
                  >
                    {togglingActive === role.slug ? "…" : "Enable"}
                  </button>
                ),
              }))}
              ariaLabel="Disabled roles list"
              columns={{ title: "Role", primaryMeta: "Dept", status: "Status", priority: "", secondaryMeta: "Runtime" }}
            />
          )}
        </div>
      )}

      {toolsEditor && (() => {
        const role = roles.find((r) => r.slug === toolsEditor);
        if (!role) return null;
        const granted = new Set(role.toolsConfig?.mcps ?? []);
        const isInherit = role.toolsConfig === null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setToolsEditor(null)}>
            <div className="w-[36rem] max-w-[92vw] rounded-lg bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-lg font-semibold">Tools for {role.name}</h2>
                <button onClick={() => setToolsEditor(null)} className="text-zinc-400 hover:text-zinc-700">✕</button>
              </div>
              <p className="text-xs text-zinc-500 mb-3">
                Choose which MCPs this role&apos;s spawned agents can use. The agent will be limited to exactly this set
                ({role.adapterType === "claude-code" ? "via --strict-mcp-config" : "via per-spawn -c overrides"}).
                Leave on <em>runtime default</em> if you want this role to inherit whatever MCPs the CLI has globally.
              </p>
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {mcpCatalog.map((mcp) => {
                  const checked = granted.has(mcp.slug);
                  const disabled = mcp.requiredEnv.length > 0 && !mcp.requiredEnvPresent;
                  return (
                    <label key={mcp.slug} className={`flex items-start gap-2 rounded border px-3 py-2 ${disabled ? "opacity-60" : "hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer"}`}>
                      <input
                        type="checkbox"
                        checked={checked && !isInherit}
                        disabled={disabled}
                        onChange={(e) => {
                          const next = new Set(granted);
                          if (e.target.checked) next.add(mcp.slug); else next.delete(mcp.slug);
                          // Convert to explicit list (i.e. exit "inherit" mode the moment user touches anything).
                          setRoles((prev) => prev.map((r) =>
                            r.slug === role.slug
                              ? { ...r, toolsConfig: { ...(r.toolsConfig ?? {}), mcps: Array.from(next) } }
                              : r,
                          ));
                        }}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <div className="font-medium text-sm">{mcp.label} <span className="font-mono text-xs text-zinc-400">{mcp.slug}</span></div>
                        <div className="text-xs text-zinc-500">{mcp.description}</div>
                        {disabled && (
                          <div className="text-xs text-amber-600 mt-1">Missing env: {mcp.requiredEnv.join(", ")}</div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="mt-4 flex gap-2 justify-end">
                <button
                  onClick={() => saveToolsConfig(role.slug, null)}
                  className="px-3 py-1.5 rounded text-sm text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  disabled={saving === role.slug}
                  title="Clear the per-role override; role will use whatever MCPs the CLI has globally."
                >
                  Reset to runtime default
                </button>
                <button
                  onClick={() => saveToolsConfig(role.slug, role.toolsConfig?.mcps ?? [])}
                  className="px-3 py-1.5 rounded text-sm bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
                  disabled={saving === role.slug}
                >
                  {saving === role.slug ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/**
 * Tunable dispatcher-wide concurrency cap. Sits in adapter_config under
 * adapter_type='dispatcher'; the dispatcher reads it on every claim
 * cycle so changes take effect immediately without a restart.
 */
function DispatcherConcurrencyBanner() {
  type DynamicConcurrencyDraft = {
    enabled: boolean;
    minConcurrentTasks: number;
    maxConcurrentTasks: number;
    step: number;
    cpuHighPercent: number;
    cpuLowPercent: number;
    memoryHighPercent: number;
    memoryLowPercent: number;
    gpuHighPercent: number;
    gpuLowPercent: number;
  };

  const defaultDynamic: DynamicConcurrencyDraft = {
    enabled: false,
    minConcurrentTasks: 1,
    maxConcurrentTasks: 8,
    step: 1,
    cpuHighPercent: 85,
    cpuLowPercent: 45,
    memoryHighPercent: 85,
    memoryLowPercent: 65,
    gpuHighPercent: 90,
    gpuLowPercent: 50,
  };

  const [current, setCurrent] = useState<number | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [currentDynamic, setCurrentDynamic] = useState<DynamicConcurrencyDraft>(defaultDynamic);
  const [dynamicDraft, setDynamicDraft] = useState<DynamicConcurrencyDraft>(defaultDynamic);
  const [baseConfig, setBaseConfig] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/adapter-config")
      .then((r) => r.json())
      .then((b) => {
        const row = (b.data || []).find((r: { adapterType: string }) => r.adapterType === "dispatcher");
        const config = (row?.config && typeof row.config === "object") ? row.config : {};
        const v = Number(row?.config?.maxConcurrentTasks);
        const n = Number.isFinite(v) && v >= 1 ? v : 5;
        const dynamic = normalizeDynamicConcurrencyDraft(row?.config?.dynamicConcurrency, n);
        setBaseConfig(config);
        setCurrent(n);
        setDraft(n);
        setCurrentDynamic(dynamic);
        setDynamicDraft(dynamic);
      })
      .catch(() => { setCurrent(5); setDraft(5); });
  }, []);

  if (current === null) return null;

  const dirty = draft !== current || JSON.stringify(dynamicDraft) !== JSON.stringify(currentDynamic);

  async function save() {
    if (draft === null || draft < 1) return;
    setSaving(true);
    setFlash(null);
    try {
      const config = {
        ...baseConfig,
        maxConcurrentTasks: draft,
        dynamicConcurrency: dynamicDraft,
      };
      const res = await fetch("/api/adapter-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapterType: "dispatcher", config }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCurrent(draft);
      setCurrentDynamic(dynamicDraft);
      setBaseConfig(config);
      setFlash("Saved — dispatcher will pick it up on the next claim cycle (within ~30s, no restart needed).");
    } catch (err) {
      setFlash(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setFlash(null), 5000);
    }
  }

  function setDynamicNumber(key: keyof DynamicConcurrencyDraft, value: number) {
    setDynamicDraft(prev => ({ ...prev, [key]: Number.isFinite(value) ? value : defaultDynamic[key] }));
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3 dark:border-amber-700/40 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-amber-900 dark:text-amber-200">Dispatcher concurrency cap:</span>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={draft ?? current}
          onChange={(e) => setDraft(parseInt(e.target.value, 10) || 1)}
          className="w-20 rounded border px-2 py-1 text-sm dark:bg-zinc-800"
          aria-label="Manual dispatcher concurrency cap"
        />
        <span className="text-xs text-amber-800/80 dark:text-amber-300/70">
          manual ceiling for tasks in flight system-wide
        </span>
        <label className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
          <input
            type="checkbox"
            checked={dynamicDraft.enabled}
            onChange={(e) => setDynamicDraft(prev => ({ ...prev, enabled: e.target.checked }))}
          />
          Auto adjust to local machine load
        </label>
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="ml-auto rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {dynamicDraft.enabled && (
        <div className="mt-3 grid gap-3 text-xs text-amber-900/85 dark:text-amber-200/80 md:grid-cols-2 xl:grid-cols-4">
          <label className="grid gap-1">
            Auto minimum
            <input
              type="number"
              min={1}
              max={50}
              value={dynamicDraft.minConcurrentTasks}
              onChange={(e) => setDynamicNumber("minConcurrentTasks", parseInt(e.target.value, 10) || 1)}
              className="rounded border px-2 py-1 text-sm dark:bg-zinc-800"
            />
          </label>
          <label className="grid gap-1">
            Auto maximum
            <input
              type="number"
              min={1}
              max={50}
              value={dynamicDraft.maxConcurrentTasks}
              onChange={(e) => setDynamicNumber("maxConcurrentTasks", parseInt(e.target.value, 10) || 1)}
              className="rounded border px-2 py-1 text-sm dark:bg-zinc-800"
            />
          </label>
          <label className="grid gap-1">
            Step
            <input
              type="number"
              min={1}
              max={20}
              value={dynamicDraft.step}
              onChange={(e) => setDynamicNumber("step", parseInt(e.target.value, 10) || 1)}
              className="rounded border px-2 py-1 text-sm dark:bg-zinc-800"
            />
          </label>
          <div className="self-end text-[0.7rem] leading-5 text-amber-800/75 dark:text-amber-300/70">
            CPU/RAM/GPU pressure reduces the effective cap; spare capacity raises it up to the manual ceiling.
          </div>
        </div>
      )}
      {flash && (
        <p className="mt-2 text-xs text-amber-800/80 dark:text-amber-300/80">{flash}</p>
      )}
    </div>
  );
}

function normalizeDynamicConcurrencyDraft(value: unknown, manualCap: number) {
  const fallback = {
    enabled: false,
    minConcurrentTasks: 1,
    maxConcurrentTasks: manualCap,
    step: 1,
    cpuHighPercent: 85,
    cpuLowPercent: 45,
    memoryHighPercent: 85,
    memoryLowPercent: 65,
    gpuHighPercent: 90,
    gpuLowPercent: 50,
  };
  if (!value || typeof value !== "object") return fallback;
  const source = value as Record<string, unknown>;
  return {
    enabled: source.enabled === true,
    minConcurrentTasks: asPositiveInt(source.minConcurrentTasks, fallback.minConcurrentTasks),
    maxConcurrentTasks: asPositiveInt(source.maxConcurrentTasks, fallback.maxConcurrentTasks),
    step: asPositiveInt(source.step, fallback.step),
    cpuHighPercent: asPositiveInt(source.cpuHighPercent, fallback.cpuHighPercent),
    cpuLowPercent: asPositiveInt(source.cpuLowPercent, fallback.cpuLowPercent),
    memoryHighPercent: asPositiveInt(source.memoryHighPercent, fallback.memoryHighPercent),
    memoryLowPercent: asPositiveInt(source.memoryLowPercent, fallback.memoryLowPercent),
    gpuHighPercent: asPositiveInt(source.gpuHighPercent, fallback.gpuHighPercent),
    gpuLowPercent: asPositiveInt(source.gpuLowPercent, fallback.gpuLowPercent),
  };
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : fallback;
}
