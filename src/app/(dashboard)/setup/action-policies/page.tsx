"use client";

import { useEffect, useMemo, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

type Decision = "allow" | "require_approval" | "block";
type EffectType = "read" | "notify" | "write" | "financial" | "destructive" | "system";

type Policy = {
  id?: string;
  hiveId?: string;
  name: string;
  enabled: boolean;
  connectorSlug: string | null;
  operation: string | null;
  effectType: EffectType | null;
  roleSlug: string | null;
  decision: Decision;
  priority: number;
  reason: string | null;
  conditions: Record<string, unknown>;
};

type RiskTier = "low" | "medium" | "high" | "critical";

type ConnectorOperation = {
  slug: string;
  label: string;
  governance: {
    effectType: EffectType;
    defaultDecision: Decision;
    summary?: string;
  };
};

type Connector = {
  slug: string;
  name: string;
  operations: ConnectorOperation[];
};

const DECISIONS: Decision[] = ["allow", "require_approval", "block"];
const EFFECT_TYPES: EffectType[] = ["read", "notify", "write", "financial", "destructive", "system"];
const RISK_TIERS: RiskTier[] = ["low", "medium", "high", "critical"];

export default function ActionPoliciesPage() {
  const { selected } = useHiveContext();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!selected?.id) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/action-policies?hiveId=${selected.id}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((body) => {
        setPolicies((body.data?.policies ?? []).map(normalizePolicy));
        setConnectors(body.data?.connectors ?? []);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError("Could not load action policies.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [selected?.id]);

  const operationsByConnector = useMemo(() => {
    return Object.fromEntries(connectors.map((connector) => [connector.slug, connector.operations]));
  }, [connectors]);

  if (!selected) {
    return (
      <div className="space-y-6">
        <Header />
        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-base font-semibold">No hive selected</h2>
          <p className="mt-2 text-sm text-zinc-500">Select a hive before configuring action policies.</p>
        </section>
      </div>
    );
  }

  function updatePolicy(index: number, patch: Partial<Policy>) {
    setPolicies((current) => current.map((policy, i) => (i === index ? { ...policy, ...patch } : policy)));
  }

  function updatePolicyConditions(index: number, patch: Record<string, unknown>) {
    setPolicies((current) => current.map((policy, i) => {
      if (i !== index) return policy;
      return {
        ...policy,
        conditions: compactConditions({ ...policy.conditions, ...patch }),
      };
    }));
  }

  function addPolicy() {
    setPolicies((current) => [
      ...current,
      {
        name: "New action policy",
        enabled: true,
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "require_approval",
        priority: 0,
        reason: null,
        conditions: {},
      },
    ]);
  }

  async function savePolicies() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/action-policies", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, policies }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setPolicies((body.data?.policies ?? []).map(normalizePolicy));
      setStatus("Action policies saved.");
    } catch {
      setError("Could not save action policies.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Header />

      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
        Business-specific rules are configured per hive; HiveWright only enforces the policy.
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addPolicy}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-300"
        >
          Add policy
        </button>
        <button
          type="button"
          onClick={savePolicies}
          disabled={saving}
          className="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium hover:border-zinc-300 disabled:opacity-60 dark:border-zinc-800 dark:hover:border-zinc-700"
        >
          {saving ? "Saving..." : "Save policies"}
        </button>
        {loading ? <span className="text-sm text-zinc-500">Loading policies...</span> : null}
        {status ? <span className="text-sm text-emerald-600">{status}</span> : null}
        {error ? <span className="text-sm text-red-600">{error}</span> : null}
      </div>

      <section className="space-y-3">
        {policies.length === 0 && !loading ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950">
            No policies yet. Add a generic policy to allow, require approval for, or block matching connector actions.
          </div>
        ) : null}

        {policies.map((policy, index) => {
          const connectorOps = policy.connectorSlug ? (operationsByConnector[policy.connectorSlug] ?? []) : [];
          const selectedOperation = connectorOps.find((op) => op.slug === policy.operation);
          return (
            <article key={policy.id ?? `new-policy-${index}`} className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">Policy name</span>
                  <input
                    aria-label="Policy name"
                    value={policy.name}
                    onChange={(event) => updatePolicy(index, { name: event.target.value })}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Connector</span>
                  <select
                    aria-label="Connector"
                    value={policy.connectorSlug ?? ""}
                    onChange={(event) => updatePolicy(index, {
                      connectorSlug: event.target.value || null,
                      operation: null,
                    })}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <option value="">Any connector</option>
                    {connectors.map((connector) => (
                      <option key={connector.slug} value={connector.slug}>{connector.name}</option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Operation</span>
                  <select
                    aria-label="Operation"
                    value={policy.operation ?? ""}
                    onChange={(event) => {
                      const operation = connectorOps.find((op) => op.slug === event.target.value);
                      updatePolicy(index, {
                        operation: event.target.value || null,
                        effectType: operation?.governance.effectType ?? policy.effectType,
                      });
                    }}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <option value="">Any operation</option>
                    {connectorOps.map((operation) => (
                      <option key={operation.slug} value={operation.slug}>{operation.label}</option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Decision</span>
                  <select
                    aria-label="Decision"
                    value={policy.decision}
                    onChange={(event) => updatePolicy(index, { decision: event.target.value as Decision })}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    {DECISIONS.map((decision) => <option key={decision} value={decision}>{decision}</option>)}
                  </select>
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Effect type</span>
                  <select
                    aria-label="Effect type"
                    value={policy.effectType ?? ""}
                    onChange={(event) => updatePolicy(index, { effectType: (event.target.value || null) as EffectType | null })}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <option value="">Any effect</option>
                    {EFFECT_TYPES.map((effectType) => <option key={effectType} value={effectType}>{effectType}</option>)}
                  </select>
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Role slug</span>
                  <input
                    aria-label="Role slug"
                    value={policy.roleSlug ?? ""}
                    onChange={(event) => updatePolicy(index, { roleSlug: event.target.value || null })}
                    placeholder="Any role"
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span className="font-medium">Priority</span>
                  <input
                    aria-label="Priority"
                    type="number"
                    value={policy.priority}
                    onChange={(event) => updatePolicy(index, { priority: Number(event.target.value) || 0 })}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  />
                </label>

                <label className="flex items-center gap-2 pt-6 text-sm">
                  <input
                    aria-label="Enabled"
                    type="checkbox"
                    checked={policy.enabled}
                    onChange={(event) => updatePolicy(index, { enabled: event.target.checked })}
                  />
                  Enabled
                </label>
              </div>

              <label className="mt-3 block space-y-1 text-sm">
                <span className="font-medium">Reason</span>
                <input
                  aria-label="Reason"
                  value={policy.reason ?? ""}
                  onChange={(event) => updatePolicy(index, { reason: event.target.value || null })}
                  placeholder="Optional owner-facing reason"
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                />
              </label>

              <div className="mt-4 rounded-md border border-zinc-100 p-3 dark:border-zinc-800">
                <h3 className="text-sm font-semibold">Conditions</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Max amount</span>
                    <input
                      aria-label="Max amount"
                      type="number"
                      value={typeof policy.conditions.maxAmount === "number" ? policy.conditions.maxAmount : ""}
                      onChange={(event) => updatePolicyConditions(index, {
                        maxAmount: event.target.value === "" ? undefined : Number(event.target.value),
                      })}
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Amount field</span>
                    <input
                      aria-label="Amount field"
                      value={stringCondition(policy.conditions.amountField)}
                      onChange={(event) => updatePolicyConditions(index, { amountField: event.target.value })}
                      placeholder="amount"
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Destination field</span>
                    <input
                      aria-label="Destination field"
                      value={stringCondition(policy.conditions.destinationField)}
                      onChange={(event) => updatePolicyConditions(index, { destinationField: event.target.value })}
                      placeholder="to"
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Risk tier at most</span>
                    <select
                      aria-label="Risk tier at most"
                      value={stringCondition(policy.conditions.riskTierAtMost)}
                      onChange={(event) => updatePolicyConditions(index, { riskTierAtMost: event.target.value || undefined })}
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <option value="">Any risk</option>
                      {RISK_TIERS.map((riskTier) => <option key={riskTier} value={riskTier}>{riskTier}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-medium">Allowed domains</span>
                    <textarea
                      aria-label="Allowed domains"
                      rows={2}
                      value={listCondition(policy.conditions.allowedDomains)}
                      onChange={(event) => updatePolicyConditions(index, { allowedDomains: lines(event.target.value) })}
                      placeholder="example.com"
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    />
                  </label>
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-medium">Allowed destinations</span>
                    <textarea
                      aria-label="Allowed destinations"
                      rows={2}
                      value={listCondition(policy.conditions.allowedDestinations)}
                      onChange={(event) => updatePolicyConditions(index, { allowedDestinations: lines(event.target.value) })}
                      placeholder="ops@example.com"
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      aria-label="Business hours only"
                      type="checkbox"
                      checked={policy.conditions.businessHoursOnly === true}
                      onChange={(event) => updatePolicyConditions(index, { businessHoursOnly: event.target.checked ? true : undefined })}
                    />
                    Business hours only
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      aria-label="Require dry run"
                      type="checkbox"
                      checked={policy.conditions.requireDryRun === true}
                      onChange={(event) => updatePolicyConditions(index, { requireDryRun: event.target.checked ? true : undefined })}
                    />
                    Require dry run
                  </label>
                </div>
                <label className="mt-3 block space-y-1 text-sm">
                  <span className="font-medium">Advanced JSON</span>
                  <textarea
                    aria-label="Advanced conditions JSON"
                    rows={3}
                    value={JSON.stringify(policy.conditions, null, 2)}
                    onChange={(event) => {
                      try {
                        const parsed = JSON.parse(event.target.value) as Record<string, unknown>;
                        updatePolicy(index, { conditions: parsed });
                      } catch {
                        updatePolicy(index, { conditions: policy.conditions });
                      }
                    }}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900"
                  />
                </label>
              </div>

              {selectedOperation ? (
                <p className="mt-3 text-xs text-zinc-500">
                  {selectedOperation.label}: {selectedOperation.governance.effectType} · default {selectedOperation.governance.defaultDecision}
                  {selectedOperation.governance.summary ? ` — ${selectedOperation.governance.summary}` : ""}
                </p>
              ) : null}

              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setPolicies((current) => current.filter((_, i) => i !== index))}
                  className="rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:border-red-300 dark:border-red-900/60 dark:text-red-300"
                >
                  Delete policy
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold">Installed connector operations</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {connectors.map((connector) => (
            <div key={connector.slug} className="rounded-md border border-zinc-100 p-3 dark:border-zinc-800">
              <h3 className="text-sm font-medium">{connector.name}</h3>
              <ul className="mt-2 space-y-1 text-xs text-zinc-500">
                {connector.operations.map((operation) => (
                  <li key={operation.slug}>
                    {operation.label}: {operation.governance.effectType} · default {operation.governance.defaultDecision}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function compactConditions(conditions: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(conditions).filter(([, value]) => {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }));
}

function stringCondition(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function listCondition(value: unknown): string {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").join("\n") : "";
}

function lines(value: string): string[] {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Action policies</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Configure generic allow, approval, and block policies for external connector actions.
      </p>
    </div>
  );
}

function normalizePolicy(policy: Partial<Policy>): Policy {
  return {
    id: policy.id,
    hiveId: policy.hiveId,
    name: policy.name ?? "Action policy",
    enabled: policy.enabled ?? true,
    connectorSlug: policy.connectorSlug ?? null,
    operation: policy.operation ?? null,
    effectType: policy.effectType ?? null,
    roleSlug: policy.roleSlug ?? null,
    decision: policy.decision ?? "require_approval",
    priority: policy.priority ?? 0,
    reason: policy.reason ?? null,
    conditions: policy.conditions ?? {},
  };
}
