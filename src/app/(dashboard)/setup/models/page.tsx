"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useHiveContext } from "@/components/hive-context";

type HealthStatus = "healthy" | "unknown" | "unhealthy";

interface SetupCredential {
  id: string;
  hiveId: string | null;
  name: string;
  key: string;
}

interface CapabilityScore {
  axis: string;
  score: number;
  rawScore: string | null;
  source: string;
  sourceUrl: string;
  benchmarkName: string;
  modelVersionMatched: string;
  confidence: string;
  updatedAt: string | null;
}

interface SetupModel {
  modelCatalogId: string | null;
  hiveModelId: string | null;
  routeKey: string;
  provider: string;
  adapterType: string;
  modelId: string;
  displayName: string;
  family: string | null;
  capabilities: string[];
  local: boolean;
  hiveEnabled: boolean;
  credentialId: string | null;
  credentialName: string | null;
  fallbackPriority: number;
  costPerInputToken: string | null;
  costPerOutputToken: string | null;
  benchmarkQualityScore: number | null;
  routingCostScore: number | null;
  capabilityScores?: CapabilityScore[];
  metadataSourceName: string | null;
  metadataSourceUrl: string | null;
  metadataLastCheckedAt: string | null;
  ownerDisabledAt: string | null;
  ownerDisabledReason: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  staleSince: string | null;
  deprecatedAt: string | null;
  discoverySource: string | null;
  status: HealthStatus;
  latencyMs: number | null;
  failureClass: string | null;
  failureMessage: string | null;
  lastProbedAt: string | null;
}

interface RoutingPolicy {
  preferences?: {
    costQualityBalance?: number;
  };
  routeOverrides?: Record<string, { enabled?: boolean; roleSlugs?: string[] }>;
  roleRoutes?: Record<string, { candidateModels?: string[] }>;
}

interface LegacyRoutingPreferences {
  minimumQualityScore?: number;
  qualityWeight?: number;
  costWeight?: number;
  localBonus?: number;
}

interface RoutingModel {
  routeKey: string;
  routingEnabled: boolean;
  roleSlugs: string[];
}

interface PreviewRoute {
  adapterType: string | null;
  model: string | null;
  source: string;
  reason: string;
  profile?: string;
  explanation?: string;
  scoreBreakdown?: {
    selectedScore: number;
    candidates: Array<{
      model: string;
      adapterType: string;
      score: number;
      capabilityFit: number;
      costScore: number;
      speedScore: number;
      selected: boolean;
      missingAxes: string[];
      lowConfidenceAxes: string[];
    }>;
  };
}

const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  preferences: {
    costQualityBalance: 50,
  },
  routeOverrides: {},
  roleRoutes: {},
};

export default function ModelSetupPage() {
  const { selected: selectedHive } = useHiveContext();
  const [models, setModels] = useState<SetupModel[]>([]);
  const [credentials, setCredentials] = useState<SetupCredential[]>([]);
  const [routingPolicy, setRoutingPolicy] = useState<RoutingPolicy>(DEFAULT_ROUTING_POLICY);
  const [routingModels, setRoutingModels] = useState<RoutingModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState("Fix TypeScript API bug");
  const [previewBrief, setPreviewBrief] = useState("Write code and Vitest coverage for the route handler.");
  const [previewAcceptanceCriteria, setPreviewAcceptanceCriteria] = useState("Tests pass and the error path is handled.");
  const [previewRoleSlug, setPreviewRoleSlug] = useState("dev-agent");
  const [previewRoute, setPreviewRoute] = useState<PreviewRoute | null>(null);

  const routingByKey = useMemo(() => {
    return new Map(routingModels.map((model) => [model.routeKey, model]));
  }, [routingModels]);

  const load = async () => {
    if (!selectedHive?.id) return;
    setLoading(true);
    setError(null);
    try {
      const [setupRes, routingRes] = await Promise.all([
        fetch(`/api/model-setup?hiveId=${selectedHive.id}`),
        fetch(`/api/model-routing?hiveId=${selectedHive.id}`),
      ]);
      const setupBody = await setupRes.json().catch(() => ({}));
      const routingBody = await routingRes.json().catch(() => ({}));
      if (!setupRes.ok) throw new Error(setupBody.error ?? `Model setup HTTP ${setupRes.status}`);
      if (!routingRes.ok) throw new Error(routingBody.error ?? `Model routing HTTP ${routingRes.status}`);
      setModels(setupBody.data?.models ?? []);
      setCredentials(setupBody.data?.credentials ?? []);
      setRoutingPolicy(normalizeRoutingPolicy(routingBody.data?.policy));
      setRoutingModels(routingBody.data?.models ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHive?.id]);

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setActionRunning(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionRunning(null);
    }
  };

  const refreshMetadata = () => runAction("metadata", async () => {
    if (!selectedHive?.id) return;
    const res = await fetch("/api/model-setup/metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: selectedHive.id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  });

  const syncModels = () => runAction("sync", async () => {
    if (!selectedHive?.id) return;
    const res = await fetch("/api/model-health/sync-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: selectedHive.id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  });

  const runProbes = () => runAction("probes", async () => {
    if (!selectedHive?.id) return;
    const enabledModelCount = models.filter((model) => model.hiveEnabled).length;
    const res = await fetch("/api/model-health/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: selectedHive.id,
        includeFresh: true,
        limit: Math.max(enabledModelCount, 1),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  });

  const updateModelUsage = async (
    model: SetupModel,
    patch: { enabled?: boolean; credentialId?: string | null; fallbackPriority?: number },
  ) => {
    if (!selectedHive?.id) return;
    setSavingModel(modelKey(model));
    setError(null);
    try {
      const res = await fetch("/api/model-setup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId: selectedHive.id,
          modelCatalogId: model.modelCatalogId,
          hiveModelId: model.hiveModelId,
          enabled: patch.enabled ?? model.hiveEnabled,
          credentialId: patch.credentialId === undefined ? model.credentialId : patch.credentialId,
          fallbackPriority: patch.fallbackPriority ?? model.fallbackPriority,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setModels(body.data?.models ?? models);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingModel(null);
    }
  };

  const setRoutingPriority = (value: number) => {
    const bounded = Math.max(0, Math.min(100, Math.round(value)));
    setRoutingPolicy((current) => ({
      ...current,
      preferences: {
        ...(current.preferences ?? {}),
        costQualityBalance: bounded,
      },
    }));
  };

  const updateRoutingOverride = (
    routeKey: string,
    patch: { enabled?: boolean; roleSlugs?: string[] },
  ) => {
    setRoutingPolicy((current) => ({
      ...current,
      routeOverrides: {
        ...(current.routeOverrides ?? {}),
        [routeKey]: {
          ...(current.routeOverrides?.[routeKey] ?? {}),
          ...patch,
        },
      },
    }));
    setRoutingModels((current) => current.map((model) =>
      model.routeKey === routeKey
        ? {
            ...model,
            routingEnabled: patch.enabled ?? model.routingEnabled,
            roleSlugs: patch.roleSlugs ?? model.roleSlugs,
          }
        : model,
    ));
  };

  const saveRoutingPolicy = () => runAction("routing", async () => {
    if (!selectedHive?.id) return;
    const res = await fetch("/api/model-routing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: selectedHive.id, policy: routingPolicy }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  });

  const previewRouting = async () => {
    if (!selectedHive?.id) return;
    setActionRunning("preview");
    setError(null);
    try {
      const params = new URLSearchParams({
        hiveId: selectedHive.id,
        previewRoleSlug: previewRoleSlug.trim() || "preview",
      });
      if (previewTitle.trim()) params.set("previewTitle", previewTitle.trim());
      if (previewBrief.trim()) params.set("previewBrief", previewBrief.trim());
      if (previewAcceptanceCriteria.trim()) {
        params.set("previewAcceptanceCriteria", previewAcceptanceCriteria.trim());
      }
      const res = await fetch(`/api/model-routing?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPreviewRoute(body.data?.previewRoute ?? null);
    } catch (err) {
      setError((err as Error).message);
      setPreviewRoute(null);
    } finally {
      setActionRunning(null);
    }
  };

  if (!selectedHive) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Model Setup</h1>
        <p className="text-sm text-zinc-500">Select a hive before assigning model credentials or routing.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Model Setup</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Global model facts with {selectedHive.name} credentials, health, and routing controls.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={syncModels} disabled={actionRunning !== null} className="rounded border px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
            {actionRunning === "sync" ? "Syncing..." : "Sync configured models"}
          </button>
          <button onClick={refreshMetadata} disabled={actionRunning !== null} className="rounded border px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
            {actionRunning === "metadata" ? "Refreshing..." : "Refresh metadata"}
          </button>
          <button onClick={runProbes} disabled={actionRunning !== null} className="rounded bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
            {actionRunning === "probes" ? "Probing..." : "Run health probes"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Routing Policy</h2>
            <p className="text-xs text-zinc-500">Controls how Auto chooses between enabled, healthy model candidates.</p>
          </div>
          <button
            onClick={saveRoutingPolicy}
            disabled={actionRunning !== null}
            className="rounded bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {actionRunning === "routing" ? "Saving..." : "Save routing policy"}
          </button>
        </div>
        <div className="grid gap-2">
          <label className="grid gap-2 text-xs text-zinc-500">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>Routing priority</span>
              <span className="font-mono text-zinc-900 dark:text-zinc-100">
                {formatRoutingPriority(routingPolicy.preferences?.costQualityBalance ?? 50)}
              </span>
            </span>
            <input
              aria-label="Routing priority"
              type="range"
              min={0}
              max={100}
              step={1}
              value={routingPolicy.preferences?.costQualityBalance ?? 50}
              onChange={(event) => setRoutingPriority(Number(event.target.value))}
              className="w-full accent-zinc-900 dark:accent-zinc-100"
            />
          </label>
          <div className="grid grid-cols-3 text-[11px] font-medium text-zinc-500">
            <span>Cost</span>
            <span className="text-center">Balanced</span>
            <span className="text-right">Quality</span>
          </div>
        </div>
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Route preview</h3>
              <p className="text-xs text-zinc-500">Try task wording against the current enabled models and policy.</p>
            </div>
            <button
              onClick={previewRouting}
              disabled={actionRunning !== null}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {actionRunning === "preview" ? "Previewing..." : "Preview route"}
            </button>
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_180px]">
            <label className="grid gap-1 text-xs text-zinc-500">
              Preview title
              <input
                value={previewTitle}
                onChange={(event) => setPreviewTitle(event.target.value)}
                className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label className="grid gap-1 text-xs text-zinc-500">
              Preview acceptance criteria
              <input
                value={previewAcceptanceCriteria}
                onChange={(event) => setPreviewAcceptanceCriteria(event.target.value)}
                className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label className="grid gap-1 text-xs text-zinc-500">
              Preview role slug
              <input
                value={previewRoleSlug}
                onChange={(event) => setPreviewRoleSlug(event.target.value)}
                className="rounded border border-zinc-200 px-2 py-1 font-mono text-xs text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label className="grid gap-1 text-xs text-zinc-500 lg:col-span-3">
              Preview brief
              <textarea
                value={previewBrief}
                rows={3}
                onChange={(event) => setPreviewBrief(event.target.value)}
                className="resize-y rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
          </div>
          {previewRoute && (
            <div className="mt-4 grid gap-3 text-xs md:grid-cols-[240px_1fr]">
              <div className="space-y-2">
                <div>
                  <div className="text-zinc-500">Profile</div>
                  <div className="font-mono text-sm text-zinc-900 dark:text-zinc-100">
                    {previewRoute.profile ?? "unclassified"}
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500">Selected model</div>
                  <div className="font-mono text-sm text-zinc-900 dark:text-zinc-100">
                    {previewRoute.model ?? "No route"}
                  </div>
                  {previewRoute.adapterType && (
                    <div className="font-mono text-[11px] text-zinc-500">{previewRoute.adapterType}</div>
                  )}
                </div>
                <div>
                  <div className="text-zinc-500">Score</div>
                  <div className="font-mono text-sm text-zinc-900 dark:text-zinc-100">
                    {formatScore(previewRoute.scoreBreakdown?.selectedScore ?? null)}
                  </div>
                </div>
              </div>
              <div className="min-w-0 space-y-3">
                <p className="text-xs text-zinc-600 dark:text-zinc-300">
                  {previewRoute.explanation ?? previewRoute.reason}
                </p>
                {(previewRoute.scoreBreakdown?.candidates.length ?? 0) > 0 && (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-[11px]">
                      <thead className="text-zinc-500">
                        <tr>
                          <th className="py-1 pr-3">Candidate</th>
                          <th className="py-1 pr-3">Score</th>
                          <th className="py-1 pr-3">Fit</th>
                          <th className="py-1 pr-3">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewRoute.scoreBreakdown?.candidates.slice(0, 5).map((candidate) => (
                          <tr key={`${candidate.adapterType}:${candidate.model}`} className={candidate.selected ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-500"}>
                            <td className="py-1 pr-3 font-mono">{candidate.model}</td>
                            <td className="py-1 pr-3 font-mono">{formatScore(candidate.score)}</td>
                            <td className="py-1 pr-3 font-mono">{formatScore(candidate.capabilityFit)}</td>
                            <td className="py-1 pr-3 font-mono">{formatScore(candidate.costScore)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold">Models</h2>
            <p className="text-xs text-zinc-500">
              {loading ? "Loading models..." : `${models.length} model${models.length === 1 ? "" : "s"} available`}
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-3 py-2">Use</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Adapter</th>
                <th className="px-3 py-2">Credential</th>
                <th className="px-3 py-2">Health</th>
                <th className="px-3 py-2">Quality</th>
                <th className="px-3 py-2">Cost</th>
                <th className="px-3 py-2">Routing</th>
                <th className="px-3 py-2">Roles</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const routing = routingByKey.get(model.routeKey);
                return (
                  <tr key={modelKey(model)} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Enable ${model.displayName}`}
                        type="checkbox"
                        checked={model.hiveEnabled}
                        disabled={savingModel === modelKey(model)}
                        onChange={(event) => updateModelUsage(model, { enabled: event.target.checked })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{model.displayName}</div>
                      <div className="font-mono text-[11px] text-zinc-500">{model.modelId}</div>
                      <div className="mt-1 flex max-w-sm flex-wrap gap-1">
                        {model.ownerDisabledAt && (
                          <ModelBadge>
                            owner disabled {formatDate(model.ownerDisabledAt)}
                            {model.ownerDisabledReason ? `: ${model.ownerDisabledReason}` : ""}
                          </ModelBadge>
                        )}
                        {model.staleSince && (
                          <ModelBadge>stale {formatDate(model.staleSince)}</ModelBadge>
                        )}
                        {model.deprecatedAt && (
                          <ModelBadge>deprecated {formatDate(model.deprecatedAt)}</ModelBadge>
                        )}
                        {model.discoverySource && (
                          <ModelBadge>source {model.discoverySource}</ModelBadge>
                        )}
                        {model.firstSeenAt && (
                          <ModelBadge>first seen {formatDate(model.firstSeenAt)}</ModelBadge>
                        )}
                        {model.lastSeenAt && (
                          <ModelBadge>last seen {formatDate(model.lastSeenAt)}</ModelBadge>
                        )}
                      </div>
                      <BenchmarkDetails scores={model.capabilityScores ?? []} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono">{model.adapterType}</div>
                      <div className="text-zinc-500">{model.local ? "local" : model.provider}</div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Credential for ${model.displayName}`}
                        value={model.credentialId ?? ""}
                        disabled={savingModel === modelKey(model)}
                        onChange={(event) => updateModelUsage(model, { credentialId: event.target.value || null, enabled: model.hiveEnabled || Boolean(event.target.value) })}
                        className="w-48 rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900"
                      >
                        <option value="">Runtime/default</option>
                        {credentials.map((credential) => (
                          <option key={credential.id} value={credential.id}>
                            {credential.key} ({credential.name})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <span className={healthClass(model.status)} title={model.failureMessage ?? model.failureClass ?? undefined}>
                        {model.status}
                      </span>
                      {model.latencyMs !== null && <div className="text-zinc-500">{model.latencyMs}ms</div>}
                    </td>
                    <td className="px-3 py-2">{formatScore(model.benchmarkQualityScore)}</td>
                    <td className="px-3 py-2">
                      <div>{formatTokenCost(model.costPerInputToken)} in</div>
                      <div>{formatTokenCost(model.costPerOutputToken)} out</div>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Routing enabled for ${model.displayName}`}
                        type="checkbox"
                        checked={routing?.routingEnabled ?? model.hiveEnabled}
                        disabled={!model.hiveEnabled}
                        onChange={(event) => updateRoutingOverride(model.routeKey, { enabled: event.target.checked })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Role slugs for ${model.displayName}`}
                        value={(routing?.roleSlugs ?? []).join(", ")}
                        placeholder="all roles"
                        onChange={(event) => updateRoutingOverride(model.routeKey, {
                          roleSlugs: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                        })}
                        className="w-44 rounded border border-zinc-200 px-2 py-1 font-mono dark:border-zinc-800 dark:bg-zinc-900"
                      />
                    </td>
                  </tr>
                );
              })}
              {models.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-zinc-500">
                    No models are in the catalog yet. Refresh metadata or sync configured models.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function normalizeRoutingPolicy(
  value: (RoutingPolicy & { preferences?: RoutingPolicy["preferences"] & LegacyRoutingPreferences }) | null | undefined,
): RoutingPolicy {
  const costQualityBalance = deriveCostQualityBalance(value?.preferences);
  return {
    preferences: {
      costQualityBalance,
    },
    routeOverrides: value?.routeOverrides ?? {},
    roleRoutes: value?.roleRoutes ?? {},
  };
}

function deriveCostQualityBalance(
  preferences: (RoutingPolicy["preferences"] & LegacyRoutingPreferences) | undefined,
) {
  if (typeof preferences?.costQualityBalance === "number" && Number.isFinite(preferences.costQualityBalance)) {
    return Math.max(0, Math.min(100, Math.round(preferences.costQualityBalance)));
  }
  const qualityWeight = preferences?.qualityWeight;
  const costWeight = preferences?.costWeight;
  if (
    typeof qualityWeight === "number"
    && Number.isFinite(qualityWeight)
    && qualityWeight >= 0
    && typeof costWeight === "number"
    && Number.isFinite(costWeight)
    && costWeight >= 0
    && qualityWeight + costWeight > 0
  ) {
    return Math.max(0, Math.min(100, Math.round((qualityWeight / (qualityWeight + costWeight)) * 100)));
  }
  return 50;
}

function formatRoutingPriority(value: number): string {
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  if (bounded < 50) return `${bounded} / 100 toward Cost`;
  if (bounded > 50) return `${bounded} / 100 toward Quality`;
  return "50 / 100 Balanced";
}

function modelKey(model: SetupModel) {
  return model.modelCatalogId ?? model.hiveModelId ?? model.routeKey;
}

function BenchmarkDetails({ scores }: { scores: CapabilityScore[] }) {
  return (
    <div className="mt-3 max-w-xl border-t border-zinc-100 pt-2 dark:border-zinc-900">
      <div className="mb-1 text-[10px] font-semibold uppercase text-zinc-500">Benchmarks</div>
      {scores.length === 0 ? (
        <div className="text-[11px] text-zinc-400">No detailed benchmark data</div>
      ) : (
        <div className="grid gap-1">
          {scores.map((score) => (
            <div
              key={`${score.axis}:${score.source}:${score.benchmarkName}:${score.modelVersionMatched}`}
              className="grid grid-cols-[76px_48px_minmax(120px,1fr)] items-center gap-2 rounded border border-zinc-100 px-2 py-1 text-[11px] dark:border-zinc-900"
            >
              <span className="font-medium text-zinc-700 dark:text-zinc-200">{formatAxis(score.axis)}</span>
              <span className="font-mono text-zinc-900 dark:text-zinc-100">{formatScore(score.score)}</span>
              <span className="min-w-0 text-zinc-500">
                <BenchmarkSource score={score} />
                <span className="mx-1 text-zinc-300">/</span>
                <span>{score.benchmarkName}</span>
                <span className="mx-1 text-zinc-300">/</span>
                <span>{score.confidence}</span>
                {score.modelVersionMatched && (
                  <>
                    <span className="mx-1 text-zinc-300">/</span>
                    <span className="font-mono">{score.modelVersionMatched}</span>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BenchmarkSource({ score }: { score: CapabilityScore }) {
  if (!score.sourceUrl) return <span>{score.source}</span>;
  return (
    <a
      href={score.sourceUrl}
      target="_blank"
      rel="noreferrer"
      className="text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
    >
      {score.source}
    </a>
  );
}

function ModelBadge({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <span
      className="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-800"
    >
      {children}
    </span>
  );
}

function healthClass(status: HealthStatus) {
  switch (status) {
    case "healthy":
      return "font-medium text-emerald-600 dark:text-emerald-400";
    case "unhealthy":
      return "font-medium text-rose-600 dark:text-rose-400";
    default:
      return "font-medium text-amber-600 dark:text-amber-400";
  }
}

function formatScore(value: number | null) {
  if (value === null) return "missing";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatAxis(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTokenCost(value: string | null) {
  if (value === null) return "missing";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "missing";
  return `$${(numeric * 1_000_000).toFixed(numeric === 0 ? 0 : 2)}/1M`;
}

function formatDate(value: string | null) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString();
}
