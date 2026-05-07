"use client";
import { useEffect, useState, useCallback } from "react";

type Provider = "ollama" | "openrouter" | "none";

interface WorkIntakeConfig {
  primaryProvider: Provider;
  primaryModel: string;
  fallbackProvider: Provider;
  fallbackModel: string;
  confidenceThreshold: number;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
}

interface ModelOption { id: string; name?: string; free?: boolean }

interface HealthEntry {
  provider: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}

const DEFAULTS: WorkIntakeConfig = {
  primaryProvider: "ollama",
  primaryModel: "qwen3:32b",
  fallbackProvider: "openrouter",
  fallbackModel: "google/gemini-2.0-flash-exp:free",
  confidenceThreshold: 0.6,
  timeoutMs: 15000,
  temperature: 0.1,
  maxTokens: 512,
};

export default function WorkIntakeSettingsPage() {
  const [config, setConfig] = useState<WorkIntakeConfig>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [ollamaModels, setOllamaModels] = useState<ModelOption[]>([]);
  const [openrouterModels, setOpenrouterModels] = useState<ModelOption[]>([]);
  const [freeOnly, setFreeOnly] = useState(true);
  const [openrouterError, setOpenrouterError] = useState<string | null>(null);

  const [health, setHealth] = useState<Record<string, HealthEntry>>({});
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/adapter-config?adapterType=work-intake");
    const body = await res.json();
    const row = (body.data || []).find((c: { adapterType: string }) => c.adapterType === "work-intake");
    if (row?.config) setConfig({ ...DEFAULTS, ...row.config });
    setLoaded(true);
  }, []);

  const loadOllamaModels = useCallback(async () => {
    const res = await fetch("/api/ollama/models");
    const body = await res.json();
    setOllamaModels((body.data || []).map((m: { id: string }) => ({
      id: m.id.replace(/^ollama\//, ""), name: m.id,
    })));
  }, []);

  const loadOpenrouterModels = useCallback(async () => {
    const res = await fetch(`/api/openrouter/models${freeOnly ? "?freeOnly=true" : ""}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "failed" }));
      setOpenrouterError(body.error || "failed to load OpenRouter models");
      setOpenrouterModels([]);
      return;
    }
    setOpenrouterError(null);
    const body = await res.json();
    setOpenrouterModels(body.data?.data || []);
  }, [freeOnly]);

  const loadHealth = useCallback(async () => {
    const res = await fetch("/api/work-intake/health");
    if (!res.ok) return;
    const body = await res.json();
    setHealth(body.data || {});
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadConfig(); loadOllamaModels(); loadHealth(); }, [loadConfig, loadOllamaModels, loadHealth]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadOpenrouterModels(); }, [loadOpenrouterModels]);

  const save = async () => {
    setSaving(true);
    await fetch("/api/adapter-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adapterType: "work-intake", config }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const runTest = async () => {
    if (!testInput.trim()) return;
    setTesting(true);
    const res = await fetch("/api/work-intake/classify?dryRun=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: testInput }),
    });
    const body = await res.json();
    setTestResult(body.data);
    setTesting(false);
  };

  if (!loaded) return <div className="p-6">Loading…</div>;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Work Intake Classifier</h1>
      <p className="text-sm text-zinc-500">
        Decides whether new work is a direct task or a goal, and picks the executor role for tasks.
        Changes save to the DB and are picked up on the next classification call (no restart).
      </p>

      <ProviderCard
        title="Primary provider"
        provider={config.primaryProvider}
        model={config.primaryModel}
        ollamaModels={ollamaModels}
        openrouterModels={openrouterModels}
        freeOnly={freeOnly}
        onFreeOnlyChange={setFreeOnly}
        openrouterError={openrouterError}
        health={health}
        onProviderChange={(p) => setConfig({ ...config, primaryProvider: p })}
        onModelChange={(m) => setConfig({ ...config, primaryModel: m })}
        onRefresh={() => { loadOllamaModels(); loadOpenrouterModels(); }}
      />
      <ProviderCard
        title="Fallback provider"
        provider={config.fallbackProvider}
        model={config.fallbackModel}
        ollamaModels={ollamaModels}
        openrouterModels={openrouterModels}
        freeOnly={freeOnly}
        onFreeOnlyChange={setFreeOnly}
        openrouterError={openrouterError}
        health={health}
        onProviderChange={(p) => setConfig({ ...config, fallbackProvider: p })}
        onModelChange={(m) => setConfig({ ...config, fallbackModel: m })}
        onRefresh={() => { loadOllamaModels(); loadOpenrouterModels(); }}
      />

      <div className="rounded-lg border p-5 space-y-4">
        <h2 className="text-lg font-medium">Tuning</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label={`Confidence threshold (${config.confidenceThreshold.toFixed(2)})`}
                 tooltip="Below this, the system defaults to creating a goal.">
            <input type="range" min="0" max="1" step="0.05"
              value={config.confidenceThreshold}
              onChange={(e) => setConfig({ ...config, confidenceThreshold: Number(e.target.value) })}
              className="w-full" />
          </Field>
          <Field label={`Temperature (${config.temperature.toFixed(2)})`}
                 tooltip="Lower = more deterministic JSON output.">
            <input type="range" min="0" max="1" step="0.05"
              value={config.temperature}
              onChange={(e) => setConfig({ ...config, temperature: Number(e.target.value) })}
              className="w-full" />
          </Field>
          <Field label="Timeout (ms)">
            <input type="number" value={config.timeoutMs}
              onChange={(e) => setConfig({ ...config, timeoutMs: Number(e.target.value) })}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800" />
          </Field>
          <Field label="Max tokens">
            <input type="number" value={config.maxTokens}
              onChange={(e) => setConfig({ ...config, maxTokens: Number(e.target.value) })}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800" />
          </Field>
        </div>
      </div>

      <div>
        <button onClick={save} disabled={saving}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {saving ? "Saving…" : saved ? "Saved" : "Save configuration"}
        </button>
      </div>

      <div className="rounded-lg border p-5 space-y-4">
        <h2 className="text-lg font-medium">Test classification</h2>
        <p className="text-sm text-zinc-500">
          Runs the classifier against your input without creating a task or goal.
        </p>
        <textarea rows={4} value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder="Enter a piece of work to classify…"
          className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800" />
        <button onClick={runTest} disabled={testing || !testInput.trim()}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {testing ? "Classifying…" : "Run classification"}
        </button>
        {testResult !== null && (
          <pre className="rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
            {JSON.stringify(testResult, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function ProviderCard(props: {
  title: string;
  provider: Provider;
  model: string;
  ollamaModels: ModelOption[];
  openrouterModels: ModelOption[];
  freeOnly: boolean;
  onFreeOnlyChange: (v: boolean) => void;
  openrouterError: string | null;
  health: Record<string, HealthEntry>;
  onProviderChange: (p: Provider) => void;
  onModelChange: (m: string) => void;
  onRefresh: () => void;
}) {
  const liveModels =
    props.provider === "ollama" ? props.ollamaModels :
    props.provider === "openrouter" ? props.openrouterModels : [];
  // Ensure the currently-configured model is always a selectable option,
  // even when the live fetch returns empty (e.g. Ollama GPU box is offline).
  const models =
    props.model && !liveModels.some((m) => m.id === props.model)
      ? [{ id: props.model, name: `${props.model} (current — provider offline)` }, ...liveModels]
      : liveModels;
  const entry = props.health[props.provider];
  const healthLabel = renderHealth(entry);

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{props.title}</h2>
        <button onClick={props.onRefresh} className="text-xs text-zinc-500 hover:underline">
          Refresh models
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Provider">
          <select value={props.provider}
            onChange={(e) => props.onProviderChange(e.target.value as Provider)}
            className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800">
            <option value="ollama">Ollama (local)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="none">None (skip — default to goal)</option>
          </select>
        </Field>
        <Field label="Model">
          {props.provider === "none" ? (
            <input disabled value="—" className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800" />
          ) : (
            <select value={props.model}
              onChange={(e) => props.onModelChange(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800">
              <option value="">Select a model…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name || m.id}{m.free ? " (free)" : ""}</option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {props.provider === "openrouter" && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={props.freeOnly}
              onChange={(e) => props.onFreeOnlyChange(e.target.checked)} />
            Free only
          </label>
          {props.openrouterError && (
            <p className="text-xs text-red-600">{props.openrouterError}</p>
          )}
        </div>
      )}

      <p className="text-xs text-zinc-500">{healthLabel}</p>
    </div>
  );
}

function Field(props: { label: string; tooltip?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400" title={props.tooltip}>
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

function renderHealth(entry: HealthEntry | undefined): string {
  if (!entry) return "No recent calls.";
  const now = Date.now();
  const fmt = (iso: string) => {
    const ago = Math.floor((now - new Date(iso).getTime()) / 60000);
    return ago < 1 ? "just now" : `${ago}m ago`;
  };
  if (entry.lastFailureAt && (!entry.lastSuccessAt || entry.lastFailureAt > entry.lastSuccessAt)) {
    return `Last failure: ${fmt(entry.lastFailureAt)} — ${entry.lastFailureReason ?? "unknown"}`;
  }
  if (entry.lastSuccessAt) return `Last success: ${fmt(entry.lastSuccessAt)}`;
  return "No recent calls.";
}
