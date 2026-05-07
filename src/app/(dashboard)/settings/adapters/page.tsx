"use client";
import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

type FieldType = "text" | "select" | "number" | "password";

interface FieldDef {
  label: string;
  key: string;
  placeholder: string;
  type: FieldType;
  options?: string[];
  description?: string;
}

interface OpenClawModel {
  id: string;
  alias: string | null;
}

const FALLBACK_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-6",
  "mistral/mistral-large-latest",
  "mistral/mistral-ocr-latest",
  "openai/gpt-5.5",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-flash-preview",
];

const ADAPTER_FIELDS: Record<string, { description: string; fields: FieldDef[] }> = {
  codex: {
    description: "Uses OpenAI-backed Codex runtimes for code-oriented work.",
    fields: [
      { label: "Default Model", key: "defaultModel", placeholder: "openai/gpt-5.5", type: "select", options: FALLBACK_MODELS },
      { label: "Timeout (seconds)", key: "timeoutSecs", placeholder: "600", type: "number", description: "Max execution time per task" },
    ],
  },
  "claude-code": {
    description: "Uses your Claude Code CLI subscription. Agents spawn via the `claude` command.",
    fields: [
      { label: "Default Model", key: "defaultModel", placeholder: "anthropic/claude-sonnet-4-6", type: "select", options: FALLBACK_MODELS },
      { label: "Max Turns", key: "maxTurns", placeholder: "50", type: "number", description: "Maximum conversation turns per task" },
      { label: "Timeout (seconds)", key: "timeoutSecs", placeholder: "600", type: "number", description: "Max execution time per task" },
    ],
  },
  gemini: {
    description: "Uses Google's Gemini CLI. Configure GEMINI_API_KEY for unattended production, or pass through Vertex/ADC, GCA, or a stable GEMINI_CLI_HOME for OAuth.",
    fields: [
      { label: "Default Model", key: "defaultModel", placeholder: "google/gemini-3.1-flash-lite-preview", type: "select", options: FALLBACK_MODELS },
      { label: "Gemini CLI Home", key: "geminiCliHome", placeholder: "~/.gemini-cli", type: "text", description: "Optional stable home for OAuth/GCA state. Leave blank for API-key or Vertex env modes." },
    ],
  },
  openclaw: {
    description: "Persistent sessions with file-based context. Used for goal supervisors and EAs.",
    fields: [
      { label: "API Endpoint", key: "apiEndpoint", placeholder: "http://localhost:18789", type: "text", description: "Auto-detected from ~/.openclaw/openclaw.json if OpenClaw is installed locally." },
      { label: "Session Timeout (seconds)", key: "sessionTimeoutSecs", placeholder: "0", type: "number", description: "Set to 0 for no timeout (recommended). EA and supervisor sessions persist indefinitely." },
    ],
  },
  ollama: {
    description: "Local models via Ollama's OpenAI-compatible API. Zero API cost.",
    fields: [
      { label: "API Endpoint", key: "apiEndpoint", placeholder: "http://localhost:11434", type: "text", description: "Ollama server address. Default port is 11434." },
      { label: "Default Model", key: "defaultModel", placeholder: "qwen3:32b", type: "text", description: "Model name as shown in 'ollama list'." },
    ],
  },
};

export default function AdapterSettingsPage() {
  const { selected: selectedHive } = useHiveContext();
  const [configs, setConfigs] = useState<Record<string, Record<string, string>>>({
    codex: {}, "claude-code": {}, gemini: {}, openclaw: {}, ollama: {},
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discoveryResult, setDiscoveryResult] = useState<Record<string, string>>({});
  const [openclawDetected, setOpenclawDetected] = useState<{ installed: boolean; endpoint: string; hasAuthToken: boolean } | null>(null);
  const [autoConfiguring, setAutoConfiguring] = useState(false);

  // Live OpenClaw config state
  const [openclawModels, setOpenclawModels] = useState<OpenClawModel[]>([]);
  const [openclawDefault, setOpenclawDefault] = useState("");
  const [openclawFallbacks, setOpenclawFallbacks] = useState<string[]>([]);
  const [openclawFallbackInput, setOpenclawFallbackInput] = useState("");
  const [savingOpenclawDefault, setSavingOpenclawDefault] = useState(false);
  const [savingOpenclawFallback, setSavingOpenclawFallback] = useState(false);
  const [savedOpenclawDefault, setSavedOpenclawDefault] = useState(false);
  const [savedOpenclawFallback, setSavedOpenclawFallback] = useState(false);

  useEffect(() => {
    fetch("/api/adapter-config")
      .then((r) => r.json())
      .then((body) => {
        const map: Record<string, Record<string, string>> = { codex: {}, "claude-code": {}, gemini: {}, openclaw: {}, ollama: {} };
        for (const c of body.data || []) {
          map[c.adapterType] = c.config || {};
        }
        setConfigs(map);
      })
      .catch(console.error);

    fetch("/api/openclaw-detect").then(r => r.json()).then(b => setOpenclawDetected(b.data)).catch(() => {});

    fetch("/api/openclaw-config?agents=false").then(r => r.json()).then(b => {
      if (b.data) {
        setOpenclawModels(b.data.availableModels || []);
        setOpenclawDefault(b.data.defaultModel || "");
        const fallbacks: string[] = b.data.fallbacks || [];
        setOpenclawFallbacks(fallbacks);
        setOpenclawFallbackInput(fallbacks[0] || "");
      }
    }).catch(() => {});
  }, []);

  const save = async (adapterType: string) => {
    setSaving(adapterType);
    await fetch("/api/adapter-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adapterType, config: configs[adapterType] }),
    });
    setSaving(null);
    setSaved(adapterType);
    setTimeout(() => setSaved(null), 2000);
  };

  const discoverModels = async (adapterType: string) => {
    if (!selectedHive?.id) return;
    setDiscovering(adapterType);
    setDiscoveryResult((prev) => ({ ...prev, [adapterType]: "" }));
    try {
      const res = await fetch("/api/model-setup/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: selectedHive.id, adapterType }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const result = body.data?.result;
      setDiscoveryResult((prev) => ({
        ...prev,
        [adapterType]: [
          `${result?.modelsSeen ?? 0} seen`,
          `${result?.modelsImported ?? 0} imported`,
          `${result?.modelsAutoEnabled ?? 0} enabled`,
          `${result?.modelsMarkedStale ?? 0} stale`,
        ].join(", "),
      }));
    } catch (err) {
      setDiscoveryResult((prev) => ({
        ...prev,
        [adapterType]: (err as Error).message,
      }));
    } finally {
      setDiscovering(null);
    }
  };

  const update = (adapterType: string, key: string, value: string) => {
    setConfigs((prev) => ({ ...prev, [adapterType]: { ...prev[adapterType], [key]: value } }));
  };

  const autoConfigure = async () => {
    setAutoConfiguring(true);
    const res = await fetch("/api/openclaw-detect/configure", { method: "POST" });
    const body = await res.json();
    if (res.ok) {
      const configRes = await fetch("/api/adapter-config");
      const configBody = await configRes.json();
      const map: Record<string, Record<string, string>> = { codex: {}, "claude-code": {}, gemini: {}, openclaw: {}, ollama: {} };
      for (const c of configBody.data || []) map[c.adapterType] = c.config || {};
      setConfigs(map);
      setSaved("openclaw");
      setTimeout(() => setSaved(null), 2000);
    }
    console.log(body);
    setAutoConfiguring(false);
  };

  const saveDefaultModel = async () => {
    if (!openclawDefault) return;
    setSavingOpenclawDefault(true);
    await fetch("/api/openclaw-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-default-model", model: openclawDefault }),
    }).catch(() => {});
    setSavingOpenclawDefault(false);
    setSavedOpenclawDefault(true);
    setTimeout(() => setSavedOpenclawDefault(false), 2000);
  };

  const saveFallback = async () => {
    setSavingOpenclawFallback(true);
    const fallbacks = openclawFallbackInput ? [openclawFallbackInput] : [];
    await fetch("/api/openclaw-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-fallbacks", fallbacks }),
    }).catch(() => {});
    setOpenclawFallbacks(fallbacks);
    setSavingOpenclawFallback(false);
    setSavedOpenclawFallback(true);
    setTimeout(() => setSavedOpenclawFallback(false), 2000);
  };

  const modelOptions = openclawModels.length > 0 ? openclawModels : FALLBACK_MODELS.map(id => ({ id, alias: null }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Adapter Configuration</h1>
      <p className="text-sm text-zinc-500">Configure connection settings for each agent runtime.</p>

      <a
        href="/setup/work-intake"
        className="block rounded-lg border p-5 hover:bg-zinc-50 dark:hover:bg-zinc-900"
      >
        <h2 className="text-lg font-medium">Work Intake Classifier →</h2>
        <p className="text-sm text-zinc-500">
          Configure how new work is classified as a task or goal, and which model the classifier uses.
        </p>
      </a>

      <a
        href="/setup/embeddings"
        className="block rounded-lg border p-5 hover:bg-zinc-50 dark:hover:bg-zinc-900"
      >
        <h2 className="text-lg font-medium">Memory Embeddings →</h2>
        <p className="text-sm text-zinc-500">
          Configure the embedding provider, model, credential, and endpoint used by memory search.
        </p>
      </a>

      {Object.entries(ADAPTER_FIELDS).map(([adapterType, { description, fields }]) => (
        <div key={adapterType} className="rounded-lg border p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium capitalize">{adapterType}</h2>
              <p className="text-sm text-zinc-500">{description}</p>
            </div>
            {saved === adapterType && <span className="text-xs text-green-600">Saved</span>}
          </div>

          {adapterType === "openclaw" && (
            <>
              {openclawDetected?.installed && (
                <div className="flex items-center justify-between rounded-md border border-green-300 bg-green-50 p-3 dark:bg-green-900/20 dark:border-green-800">
                  <div>
                    <p className="text-sm font-medium text-green-800 dark:text-green-200">OpenClaw detected at {openclawDetected.endpoint}</p>
                    <p className="text-xs text-green-600 dark:text-green-400">Auth token found. Click to auto-configure.</p>
                  </div>
                  <button onClick={autoConfigure} disabled={autoConfiguring}
                    className="rounded-md bg-green-600 px-3 py-1.5 text-xs text-white hover:bg-green-700 disabled:opacity-50">
                    {autoConfiguring ? "Configuring..." : "Auto-configure"}
                  </button>
                </div>
              )}
              {openclawDetected && !openclawDetected.installed && (
                <p className="text-xs text-zinc-400">OpenClaw not detected locally. Enter configuration manually below.</p>
              )}

              {/* Live OpenClaw model config */}
              {openclawModels.length > 0 && (
                <div className="space-y-3 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Live OpenClaw Config</p>

                  <div className="space-y-1">
                    <label htmlFor="openclaw-default-model" className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Default Model (from OpenClaw)</label>
                    <div className="flex gap-2">
                      <select
                        id="openclaw-default-model"
                        value={openclawDefault}
                        onChange={e => setOpenclawDefault(e.target.value)}
                        className="flex-1 rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                      >
                        <option value="">Select a model...</option>
                        {modelOptions.map(m => (
                          <option key={m.id} value={m.id}>{m.id}{m.alias ? ` (${m.alias})` : ""}</option>
                        ))}
                      </select>
                      <button
                        onClick={saveDefaultModel}
                        disabled={savingOpenclawDefault || !openclawDefault}
                        className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        {savingOpenclawDefault ? "Saving..." : savedOpenclawDefault ? "Saved" : "Save"}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="openclaw-fallback-model" className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Fallback Model</label>
                    <p className="text-xs text-zinc-400">Used when the default model is unavailable.</p>
                    <div className="flex gap-2">
                      <select
                        id="openclaw-fallback-model"
                        value={openclawFallbackInput}
                        onChange={e => setOpenclawFallbackInput(e.target.value)}
                        className="flex-1 rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                      >
                        <option value="">None</option>
                        {modelOptions.map(m => (
                          <option key={m.id} value={m.id}>{m.id}{m.alias ? ` (${m.alias})` : ""}</option>
                        ))}
                      </select>
                      <button
                        onClick={saveFallback}
                        disabled={savingOpenclawFallback}
                        className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        {savingOpenclawFallback ? "Saving..." : savedOpenclawFallback ? "Saved" : "Save"}
                      </button>
                    </div>
                    {openclawFallbacks.length > 0 && (
                      <p className="text-xs text-zinc-400">
                        Current: {openclawFallbacks.join(", ")}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-4">
            {fields.map((f) => {
              const fieldId = `adapter-${adapterType}-${f.key}`;
              return (
                <div key={f.key} className="space-y-1">
                  <label htmlFor={fieldId} className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{f.label}</label>
                  {f.type === "select" ? (
                    <select
                      id={fieldId}
                      value={configs[adapterType]?.[f.key] || ""}
                      onChange={(e) => update(adapterType, f.key, e.target.value)}
                      className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                    >
                      <option value="">Default ({f.placeholder})</option>
                      {(f.options || []).map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={fieldId}
                      type={f.type === "number" ? "number" : f.type === "password" ? "password" : "text"}
                      value={configs[adapterType]?.[f.key] || ""}
                      onChange={(e) => update(adapterType, f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                    />
                  )}
                  {f.description && <p className="text-xs text-zinc-400">{f.description}</p>}
                </div>
              );
            })}
          </div>
          <button
            onClick={() => save(adapterType)}
            disabled={saving === adapterType}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {saving === adapterType ? "Saving..." : "Save Configuration"}
          </button>
          {adapterType !== "openclaw" && selectedHive?.id && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => discoverModels(adapterType)}
                disabled={discovering !== null}
                aria-label={`Discover ${adapterType} models`}
                className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-900"
              >
                {discovering === adapterType ? "Discovering..." : "Discover models"}
              </button>
              {discoveryResult[adapterType] && (
                <span className="text-xs text-zinc-500">{discoveryResult[adapterType]}</span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
