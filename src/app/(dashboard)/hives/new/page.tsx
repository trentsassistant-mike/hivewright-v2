"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { generateHiveAddress } from "@/hives/address";

const HIVE_TYPES = ["physical", "digital", "greenfield"];
const SETUP_WELCOME_DISMISSED_KEY = "hivewright.setupWelcomeDismissed";

const WELCOME_CONCEPTS = [
  {
    term: "HiveWright",
    description: "HiveWright is the operating system for your hive: the business, project, or life area you want help running. It keeps the work moving and brings you in when your judgement is needed.",
  },
  {
    term: "EA",
    description: "Your EA is the front door for the hive. It helps you give direction, ask questions, and keep track of what is happening.",
  },
  {
    term: "Agents",
    description: "Agents are specialist workers that take on tasks for the hive. They research, build, check, and report back based on the mission you set.",
  },
  {
    term: "Dispatcher",
    description: "The dispatcher is the work coordinator. It decides which agent should handle each task and keeps the queue moving.",
  },
  {
    term: "Decisions",
    description: "Decisions are the moments where HiveWright needs your call. You approve, reject, or guide the next move so the hive stays aligned with you.",
  },
  {
    term: "Connectors",
    description: "Connectors let HiveWright work with services you already use, such as chat, email, repositories, and other tools. You can add them now or later.",
  },
  {
    term: "Schedules",
    description: "Schedules are recurring checks or jobs. They let the hive review things on a rhythm without waiting for you to remember.",
  },
  {
    term: "Memory",
    description: "Memory is what HiveWright learns about your hive over time. It helps future work start with the right context instead of starting from scratch.",
  },
];

const ADAPTER_GROUPS = [
  {
    label: "Recommended managed runtimes",
    adapters: [
      {
        value: "codex",
        label: "Codex",
        description: "Runs agents through the Codex CLI using the owner's Codex or ChatGPT authentication.",
      },
      {
        value: "claude-code",
        label: "Claude Code",
        description: "Runs agents through the Claude Code CLI using the owner's signed-in CLI session.",
      },
      {
        value: "gemini",
        label: "Gemini CLI",
        description: "Runs agents through Google's Gemini CLI.",
      },
    ],
  },
  {
    label: "Local or self-hosted runtimes",
    adapters: [
      {
        value: "ollama",
        label: "Ollama",
        description: "Runs agents against local models exposed by Ollama.",
      },
    ],
  },
];

const ADAPTER_LABELS = Object.fromEntries(
  ADAPTER_GROUPS.flatMap((group) => group.adapters.map((adapter) => [adapter.value, adapter.label])),
) as Record<string, string>;

const RUNTIME_PRESETS = [
  {
    value: "codex",
    label: "Recommended",
    description: "Best starting point for most hives. HiveWright chooses capable defaults for each worker.",
  },
  {
    value: "claude-code",
    label: "Claude Code",
    description: "Use this when your local Claude Code session is the preferred way to run workers.",
  },
  {
    value: "gemini",
    label: "Gemini CLI",
    description: "Use this when your local Gemini CLI session is the preferred way to run workers.",
  },
  {
    value: "ollama",
    label: "Local models",
    description: "Use this when workers should run through a local model service you manage.",
  },
];

const ANTHROPIC_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-6",
];
const CODEX_MODELS = [
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.3-codex",
];
const GEMINI_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-flash-preview",
];
const GENERAL_MODELS = [
  ...ANTHROPIC_MODELS,
  ...CODEX_MODELS,
  "mistral/mistral-large-latest",
  "mistral/mistral-ocr-latest",
  "openai/gpt-5.5",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  ...GEMINI_MODELS,
];

const EA_DISCORD_CONNECTOR_SLUG = "ea-discord";
const REVIEW_STEP = 7;
const PROJECTS_STEP = 6;

type RequestSortingPreset = "balanced" | "direct" | "goals";

interface ProjectEntry {
  name: string;
  slug: string;
  workspacePath: string;
}

interface SetupField {
  key: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  type?: "text" | "url" | "password" | "textarea";
  required?: boolean;
}

interface Connector {
  slug: string;
  name: string;
  category: string;
  description: string;
  icon: string | null;
  authType: "api_key" | "oauth2" | "webhook" | "none";
  setupFields: SetupField[];
  operations: { slug: string; label: string }[];
  requiresDispatcherRestart?: boolean;
}

interface Role {
  slug: string;
  name: string;
  department: string;
  adapterType: string;
  recommendedModel: string;
}

interface WizardState {
  name: string;
  slug: string;
  type: string;
  description: string;
  mission: string;
  initialGoal: string;
  roleOverrides: Record<string, { adapter?: string; model?: string }>;
  connectorSelections: Record<string, "skipped" | "configure-later" | "configured">;
  connectorDisplayNames: Record<string, string>;
  connectorFields: Record<string, Record<string, string>>;
  projects: ProjectEntry[];
  operatingPreferences: {
    maxConcurrentAgents: number;
    proactiveWork: boolean;
    memorySearch: boolean;
    requestSorting: RequestSortingPreset;
  };
}

export default function NewHiveWizard() {
  const router = useRouter();
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);
  const [step, setStep] = useState(1);
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(true);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [expandedConnector, setExpandedConnector] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<string | null>(null);
  const [customAddressEdited, setCustomAddressEdited] = useState(false);
  const [runtimeAdvancedOpen, setRuntimeAdvancedOpen] = useState(false);
  const [projectAdvancedOpen, setProjectAdvancedOpen] = useState<Record<number, boolean>>({});

  const [state, setState] = useState<WizardState>({
    name: "",
    slug: "",
    type: "digital",
    description: "",
    mission: "",
    initialGoal: "",
    roleOverrides: {},
    connectorSelections: {},
    connectorDisplayNames: {},
    connectorFields: {},
    projects: [],
    operatingPreferences: {
      maxConcurrentAgents: 3,
      proactiveWork: true,
      memorySearch: true,
      requestSorting: "balanced",
    },
  });

  const hasProjectsStep = state.type !== "physical";
  const totalSteps = hasProjectsStep ? REVIEW_STEP : REVIEW_STEP - 1;
  const displayStep = hasProjectsStep || step < REVIEW_STEP ? step : REVIEW_STEP - 1;
  const isLastStep = step === REVIEW_STEP;
  const isFirstStep = step === 1;
  const hiveAddress = state.slug || generateHiveAddress(state.name);
  const eaDiscordConnector = connectors.find((connector) => connector.slug === EA_DISCORD_CONNECTOR_SLUG) ?? null;
  const serviceConnectors = useMemo(
    () => connectors.filter((connector) => connector.slug !== EA_DISCORD_CONNECTOR_SLUG),
    [connectors],
  );

  const update = (partial: Partial<WizardState>) => setState((prev) => ({ ...prev, ...partial }));
  const autoSlug = generateHiveAddress;
  const updateOperatingPreferences = (partial: Partial<WizardState["operatingPreferences"]>) => {
    setState((prev) => ({
      ...prev,
      operatingPreferences: { ...prev.operatingPreferences, ...partial },
    }));
  };

  useEffect(() => {
    setShowWelcome(localStorage.getItem(SETUP_WELCOME_DISMISSED_KEY) !== "true");
  }, []);

  const continueFromWelcome = () => {
    localStorage.setItem(SETUP_WELCOME_DISMISSED_KEY, "true");
    setShowWelcome(false);
  };

  const updateHiveName = (name: string) => {
    setState((prev) => ({
      ...prev,
      name,
      slug: customAddressEdited ? prev.slug : autoSlug(name),
    }));
  };

  const updateHiveAddress = (value: string) => {
    setCustomAddressEdited(true);
    update({ slug: autoSlug(value) });
  };

  const loadConnectors = () => {
    setConnectorsLoading(true);
    setConnectorsError(null);
    fetch("/api/connectors")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => setConnectors(body.data ?? []))
      .catch((err) => {
        setConnectors([]);
        setConnectorsError(`Connector catalog could not be loaded: ${(err as Error).message}`);
      })
      .finally(() => setConnectorsLoading(false));
  };

  useEffect(() => {
    fetch("/api/roles")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => setRoles(body.data || []))
      .catch((err) => setRolesError(`Role defaults could not be loaded: ${(err as Error).message}`));

    loadConnectors();
  }, []);

  const connectorsByCategory = useMemo(() => {
    const grouped: Record<string, Connector[]> = {};
    for (const connector of serviceConnectors) {
      (grouped[connector.category] ||= []).push(connector);
    }
    return grouped;
  }, [serviceConnectors]);

  const recommendedConnectors = useMemo(() => {
    const preferred = ["discord-webhook", "github-pat", "gmail"];
    const seen = new Set<string>();
    const picked = preferred
      .map((slug) => serviceConnectors.find((connector) => connector.slug === slug))
      .filter((connector): connector is Connector => Boolean(connector));
    for (const connector of picked) seen.add(connector.slug);
    return [...picked, ...serviceConnectors.filter((connector) => !seen.has(connector.slug)).slice(0, Math.max(0, 6 - picked.length))];
  }, [serviceConnectors]);

  const getSelectedAdapter = (role: Role) => state.roleOverrides[role.slug]?.adapter ?? normalizeAdapter(role.adapterType);
  const getSelectedModel = (role: Role) => state.roleOverrides[role.slug]?.model ?? role.recommendedModel;

  const modelsForAdapter = (adapter: string) => {
    switch (adapter) {
      case "claude-code":
        return ANTHROPIC_MODELS;
      case "codex":
        return CODEX_MODELS;
      case "gemini":
        return GEMINI_MODELS;
      default:
        return GENERAL_MODELS;
    }
  };

  const setRoleOverride = (role: Role, field: "adapter" | "model", value: string) => {
    setState((prev) => {
      const next = { ...prev.roleOverrides[role.slug], [field]: value };
      if (field === "adapter") {
        const models = modelsForAdapter(value);
        if (!models.includes(next.model ?? role.recommendedModel)) {
          next.model = models[0];
        }
      }
      return {
        ...prev,
        roleOverrides: { ...prev.roleOverrides, [role.slug]: next },
      };
    });
  };

  const applyAdapterToAllRoles = (adapter: string) => {
    setState((prev) => {
      const next = { ...prev.roleOverrides };
      for (const role of roles) {
        const models = modelsForAdapter(adapter);
        next[role.slug] = {
          ...next[role.slug],
          adapter,
          model: models.includes(next[role.slug]?.model ?? role.recommendedModel)
            ? next[role.slug]?.model ?? role.recommendedModel
            : models[0],
        };
      }
      return { ...prev, roleOverrides: next };
    });
  };

  const selectRuntimePreset = (adapter: string) => {
    applyAdapterToAllRoles(adapter);
  };

  const selectConnector = (slug: string, selection: "skipped" | "configure-later" | "configured") => {
    setState((prev) => ({
      ...prev,
      connectorSelections: { ...prev.connectorSelections, [slug]: selection },
    }));
  };

  const updateConnectorField = (slug: string, key: string, value: string) => {
    setState((prev) => ({
      ...prev,
      connectorFields: {
        ...prev.connectorFields,
        [slug]: { ...prev.connectorFields[slug], [key]: value },
      },
    }));
  };

  const updateConnectorDisplayName = (slug: string, value: string) => {
    setState((prev) => ({
      ...prev,
      connectorDisplayNames: { ...prev.connectorDisplayNames, [slug]: value },
    }));
  };

  const addProject = () => {
    setState((prev) => ({
      ...prev,
      projects: [...prev.projects, { name: "", slug: "", workspacePath: "" }],
    }));
  };

  const updateProject = (index: number, field: keyof ProjectEntry, value: string) => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((project, i) => {
        if (i !== index) return project;
        const updated = { ...project, [field]: value };
        if (field === "name" && !project.slug) updated.slug = autoSlug(value);
        return updated;
      }),
    }));
  };

  const removeProject = (index: number) => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.filter((_, i) => i !== index),
    }));
    setProjectAdvancedOpen((prev) => {
      const next: Record<number, boolean> = {};
      Object.entries(prev).forEach(([key, value]) => {
        const numericKey = Number(key);
        if (numericKey < index) next[numericKey] = value;
        if (numericKey > index) next[numericKey - 1] = value;
      });
      return next;
    });
  };

  const goNext = () => {
    if (!hasProjectsStep && step === PROJECTS_STEP - 1) setStep(REVIEW_STEP);
    else setStep((s) => s + 1);
  };

  const goBack = () => {
    if (!hasProjectsStep && step === REVIEW_STEP) setStep(PROJECTS_STEP - 1);
    else setStep((s) => s - 1);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setSetupStatus("Setting up your hive...");
    try {
      const configuredConnectors = connectors
        .filter((connector) => state.connectorSelections[connector.slug] === "configured")
        .map((connector) => ({
          connectorSlug: connector.slug,
          displayName: state.connectorDisplayNames[connector.slug] || connector.name,
          fields: state.connectorFields[connector.slug] ?? {},
        }));

      const setupRes = await fetch("/api/hives/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hive: {
            name: state.name,
            slug: hiveAddress,
            type: state.type,
            description: state.description,
            mission: state.mission,
          },
          roleOverrides: Object.fromEntries(
            Object.entries(state.roleOverrides)
              .filter(([, override]) => override.adapter || override.model)
              .map(([slug, override]) => [
                slug,
                {
                  adapterType: override.adapter,
                  recommendedModel: override.model,
                },
              ]),
          ),
          connectors: configuredConnectors,
          projects: state.projects
            .filter((project) => project.name || project.slug || project.workspacePath)
            .map((project) => ({
              name: project.name,
              slug: project.slug,
              workspacePath: project.workspacePath || undefined,
            })),
          initialGoal: state.initialGoal || undefined,
          operatingPreferences: state.operatingPreferences,
        }),
      });
      const setupBody = await setupRes.json();
      if (!setupRes.ok) throw new Error(setupBody.error || "Hive setup did not finish. Please try again.");
      const hiveId = setupBody.data.id;

      localStorage.setItem("selectedHiveId", hiveId);
      router.push("/setup/health");
    } catch (err: unknown) {
      setSetupStatus(null);
      setError(err instanceof Error ? err.message : "Hive setup did not finish. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (showWelcome === null) {
    return null;
  }

  if (showWelcome) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="space-y-6 rounded-lg border p-5 sm:p-6" aria-labelledby="setup-welcome-title">
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-500">Hive setup</p>
            <h1 id="setup-welcome-title" className="text-2xl font-semibold">Before you create your hive</h1>
            <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              This setup will ask for the basics HiveWright needs to start running work for you. These are the ideas you will see during setup and while the hive operates.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {WELCOME_CONCEPTS.map((concept) => (
              <div key={concept.term} className="rounded-md border bg-zinc-50 p-4 dark:bg-zinc-900">
                <h2 className="text-sm font-semibold">{concept.term}</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{concept.description}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-zinc-500">You will only see this introduction once in this browser.</p>
            <button
              type="button"
              onClick={continueFromWelcome}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Continue to setup
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Create a Hive</h1>
        <p className="text-sm text-zinc-500">Step {displayStep} of {totalSteps}</p>
      </div>

      <div className="flex gap-1" aria-label="Wizard progress">
        {Array.from({ length: totalSteps }, (_, index) => index + 1).map((s) => (
          <div
            key={s}
            className={`h-1.5 flex-1 rounded-full ${s <= displayStep ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-200 dark:bg-zinc-800"}`}
          />
        ))}
      </div>

      {step === 1 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="hive-step-title">
          <div>
            <h2 id="hive-step-title" className="text-lg font-medium">Create a Hive</h2>
            <p className="text-sm text-zinc-500">Give HiveWright the operating context agents will use when they plan and act.</p>
          </div>
          <div className="space-y-3">
            <div>
              <label htmlFor="hive-name" className="text-sm font-medium">Hive name *</label>
              <input
                id="hive-name"
                value={state.name}
                onChange={(e) => updateHiveName(e.target.value)}
                placeholder="My Hive"
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
            </div>
            <details className="rounded-md border border-dashed p-3">
              <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
              <div className="mt-3">
                <label htmlFor="hive-address" className="text-sm font-medium">Custom hive address</label>
                <input
                  id="hive-address"
                  value={hiveAddress}
                  onChange={(e) => updateHiveAddress(e.target.value)}
                  placeholder="my-hive"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm font-mono dark:bg-zinc-800"
                />
                <p className="mt-1 text-xs text-zinc-400">Used for this hive&apos;s local folders and links. Lowercase letters, numbers, and dashes work best.</p>
              </div>
            </details>
            <div>
              <label htmlFor="hive-type" className="text-sm font-medium">Type *</label>
              <select
                id="hive-type"
                value={state.type}
                onChange={(e) => update({ type: e.target.value })}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              >
                {HIVE_TYPES.map((type) => (
                  <option key={type} value={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="hive-description" className="text-sm font-medium">Description</label>
              <textarea
                id="hive-description"
                value={state.description}
                onChange={(e) => update({ description: e.target.value })}
                rows={3}
                placeholder="What does this hive do?"
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
            </div>
            <div>
              <label htmlFor="hive-mission" className="text-sm font-medium">Mission</label>
              <textarea
                id="hive-mission"
                value={state.mission}
                onChange={(e) => update({ mission: e.target.value })}
                rows={5}
                placeholder="The durable purpose of this hive."
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
              <p className="mt-1 text-xs text-zinc-400">Agents use this to decide what matters when work is ambiguous.</p>
            </div>
            <div>
              <label htmlFor="hive-initial-goal" className="text-sm font-medium">First goal</label>
              <textarea
                id="hive-initial-goal"
                value={state.initialGoal}
                onChange={(e) => update({ initialGoal: e.target.value })}
                rows={2}
                placeholder="Optional. What should this hive achieve first?"
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
              <p className="mt-1 text-xs text-zinc-400">HiveWright will turn this into a goal after the hive is created.</p>
            </div>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="runtime-step-title">
          <div>
            <h2 id="runtime-step-title" className="text-lg font-medium">Choose agent runtimes</h2>
            <p className="text-sm text-zinc-500">Choose how HiveWright should run its workers. The recommended option is right for most owners.</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {RUNTIME_PRESETS.map((preset) => (
              <label key={preset.value} className="flex cursor-pointer gap-3 rounded-md border p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <input
                  type="radio"
                  name="runtime-preset"
                  checked={roles.length === 0 ? preset.value === "codex" : roles.every((role) => getSelectedAdapter(role) === preset.value)}
                  onChange={() => selectRuntimePreset(preset.value)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm font-medium">{preset.label}</span>
                  <span className="block text-xs leading-5 text-zinc-500">{preset.description}</span>
                </span>
              </label>
            ))}
          </div>

          {rolesError && (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {rolesError}
            </p>
          )}

          <div className="rounded-md border border-dashed p-3">
            <button
              type="button"
              onClick={() => setRuntimeAdvancedOpen((open) => !open)}
              className="text-sm font-medium"
              aria-expanded={runtimeAdvancedOpen}
            >
              Advanced runtime details
            </button>
            {runtimeAdvancedOpen && (
              <div className="mt-3 space-y-3">
                {roles.map((role, index) => {
                  const adapter = getSelectedAdapter(role);
                  const models = modelsForAdapter(adapter);
                  const currentModel = getSelectedModel(role);
                  return (
                    <div key={role.slug} className="rounded-md border p-3">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-sm">{role.name}</div>
                          <div className="text-xs text-zinc-400">{role.department || "system"}</div>
                        </div>
                        {index === 0 && (
                          <button
                            type="button"
                            onClick={() => applyAdapterToAllRoles(adapter)}
                            className="rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800"
                          >
                            Use this for all roles
                          </button>
                        )}
                      </div>
                      <div className="grid gap-2 md:grid-cols-2">
                        <div>
                          <label htmlFor={`adapter-${role.slug}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Adapter</label>
                          <select
                            id={`adapter-${role.slug}`}
                            value={adapter}
                            onChange={(e) => setRoleOverride(role, "adapter", e.target.value)}
                            className="mt-1 w-full rounded border px-2 py-1.5 text-sm dark:bg-zinc-800"
                          >
                            {ADAPTER_GROUPS.map((group) => (
                              <optgroup key={group.label} label={group.label}>
                                {group.adapters.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`model-${role.slug}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Model</label>
                          <select
                            id={`model-${role.slug}`}
                            value={models.includes(currentModel) ? currentModel : models[0]}
                            onChange={(e) => setRoleOverride(role, "model", e.target.value)}
                            className="mt-1 w-full rounded border px-2 py-1.5 text-sm dark:bg-zinc-800"
                          >
                            {models.map((model) => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!rolesError && roles.length === 0 && (
                  <p className="text-sm text-zinc-400">Role defaults are loading.</p>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="operating-step-title">
          <div>
            <h2 id="operating-step-title" className="text-lg font-medium">Set working preferences</h2>
            <p className="text-sm text-zinc-500">Choose how much initiative this hive should take when it starts operating.</p>
          </div>

          <div className="space-y-5">
            <div>
              <label htmlFor="max-concurrent-agents" className="text-sm font-medium">How many agents may work at once?</label>
              <input
                id="max-concurrent-agents"
                type="number"
                min={1}
                max={50}
                step={1}
                value={state.operatingPreferences.maxConcurrentAgents}
                onChange={(e) => updateOperatingPreferences({ maxConcurrentAgents: Number.parseInt(e.target.value, 10) || 1 })}
                className="mt-1 w-24 rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
              <p className="mt-1 text-xs text-zinc-400">Three is a steady starting point: enough parallel work without making the hive noisy.</p>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Should HiveWright look for useful work on its own?</legend>
              <RadioChoice
                name="proactive-work"
                checked={state.operatingPreferences.proactiveWork}
                onChange={() => updateOperatingPreferences({ proactiveWork: true })}
                title="Yes, keep an eye out"
                description="HiveWright will run its built-in recurring checks and bring important findings back to you."
              />
              <RadioChoice
                name="proactive-work"
                checked={!state.operatingPreferences.proactiveWork}
                onChange={() => updateOperatingPreferences({ proactiveWork: false })}
                title="No, wait for me"
                description="Recurring checks are created paused so you can turn them on later."
              />
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Should HiveWright prepare memory search for this hive?</legend>
              <RadioChoice
                name="memory-search"
                checked={state.operatingPreferences.memorySearch}
                onChange={() => updateOperatingPreferences({ memorySearch: true })}
                title="Yes, help future work remember context"
                description="HiveWright will mark this hive ready to use memory search as knowledge is added."
              />
              <RadioChoice
                name="memory-search"
                checked={!state.operatingPreferences.memorySearch}
                onChange={() => updateOperatingPreferences({ memorySearch: false })}
                title="Not yet"
                description="You can turn this on later after the hive is running."
              />
            </fieldset>

            <div>
              <label htmlFor="request-sorting" className="text-sm font-medium">How should new requests be sorted?</label>
              <select
                id="request-sorting"
                value={state.operatingPreferences.requestSorting}
                onChange={(e) => updateOperatingPreferences({ requestSorting: e.target.value as RequestSortingPreset })}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              >
                <option value="balanced">Balanced: choose a task or goal based on the request</option>
                <option value="direct">Prefer direct tasks when the request is clear</option>
                <option value="goals">Prefer goals when the request may need planning</option>
              </select>
            </div>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="ea-step-title">
          <div>
            <h2 id="ea-step-title" className="text-lg font-medium">Set up your Discord EA</h2>
            <p className="text-sm text-zinc-500">Your EA can answer you in Discord and help you start work without opening HiveWright.</p>
          </div>

          {connectorsLoading && <p className="text-sm text-zinc-400">Loading EA setup.</p>}
          {connectorsError && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              <p>{connectorsError}</p>
              <button type="button" onClick={loadConnectors} className="mt-2 rounded-md border px-3 py-1 text-xs">Retry</button>
            </div>
          )}

          {!connectorsLoading && !connectorsError && !eaDiscordConnector && (
            <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500">
              Discord EA setup is not available in this environment. You can create the hive now and add it later.
            </p>
          )}

          {eaDiscordConnector && (
            <EaDiscordSetup
              connector={eaDiscordConnector}
              fields={state.connectorFields[eaDiscordConnector.slug] ?? {}}
              displayName={state.connectorDisplayNames[eaDiscordConnector.slug] ?? ""}
              selection={state.connectorSelections[eaDiscordConnector.slug]}
              onSelect={selectConnector}
              onFieldChange={updateConnectorField}
              onDisplayNameChange={updateConnectorDisplayName}
            />
          )}
        </section>
      )}

      {step === 5 && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="connectors-step-title">
          <div>
            <h2 id="connectors-step-title" className="text-lg font-medium">Connect services</h2>
            <p className="text-sm text-zinc-500">Authorize the services this hive can use. You can skip any connector and add it later.</p>
          </div>

          {connectorsLoading && <p className="text-sm text-zinc-400">Loading connector catalog.</p>}
          {connectorsError && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              <p>{connectorsError}</p>
              <button type="button" onClick={loadConnectors} className="mt-2 rounded-md border px-3 py-1 text-xs">Retry</button>
            </div>
          )}
          {!connectorsLoading && !connectorsError && serviceConnectors.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500">No connectors are available in this environment. You can create the hive now and add services later.</p>
          )}

          {recommendedConnectors.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Recommended</h3>
              <div className="grid gap-3 md:grid-cols-2">
                {recommendedConnectors.map((connector) => (
                  <ConnectorCard
                    key={connector.slug}
                    connector={connector}
                    expanded={expandedConnector === connector.slug}
                    fields={state.connectorFields[connector.slug] ?? {}}
                    displayName={state.connectorDisplayNames[connector.slug] ?? ""}
                    selection={state.connectorSelections[connector.slug]}
                    onToggle={() => setExpandedConnector(expandedConnector === connector.slug ? null : connector.slug)}
                    onSelect={selectConnector}
                    onFieldChange={updateConnectorField}
                    onDisplayNameChange={updateConnectorDisplayName}
                  />
                ))}
              </div>
            </div>
          )}

          {Object.keys(connectorsByCategory).length > 0 && (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">Browse all connectors</summary>
              <div className="mt-3 space-y-4">
                {Object.entries(connectorsByCategory).map(([category, list]) => (
                  <div key={category}>
                    <p className="mb-2 text-xs font-medium uppercase text-zinc-500">{category}</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {list.map((connector) => (
                        <ConnectorCard
                          key={connector.slug}
                          connector={connector}
                          expanded={expandedConnector === connector.slug}
                          fields={state.connectorFields[connector.slug] ?? {}}
                          displayName={state.connectorDisplayNames[connector.slug] ?? ""}
                          selection={state.connectorSelections[connector.slug]}
                          onToggle={() => setExpandedConnector(expandedConnector === connector.slug ? null : connector.slug)}
                          onSelect={selectConnector}
                          onFieldChange={updateConnectorField}
                          onDisplayNameChange={updateConnectorDisplayName}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="rounded-md border border-dashed p-3">
            <summary className="cursor-pointer text-sm font-medium">Advanced manual setup</summary>
            <p className="mt-2 text-sm text-zinc-500">
              Use this only when there is no connector or authorization flow for the service yet. Manual values stay scoped to the connector you configure here.
            </p>
          </details>
        </section>
      )}

      {step === PROJECTS_STEP && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="projects-step-title">
          <div>
            <h2 id="projects-step-title" className="text-lg font-medium">Projects</h2>
            <p className="text-sm text-zinc-500">Add projects this hive should operate on. You can add more later.</p>
          </div>

          {state.projects.map((project, index) => (
            <div key={index} className="space-y-2 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Project {index + 1}</span>
                <button onClick={() => removeProject(index)} className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
              <div>
                <label htmlFor={`project-name-${index}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Name *</label>
                <input
                  id={`project-name-${index}`}
                  placeholder="HiveWright v2"
                  value={project.name}
                  onChange={(e) => updateProject(index, "name", e.target.value)}
                  className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm dark:bg-zinc-800"
                />
              </div>
              <div>
                <label htmlFor={`project-slug-${index}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Project address *</label>
                <input
                  id={`project-slug-${index}`}
                  placeholder="hivewrightv2"
                  value={project.slug}
                  onChange={(e) => updateProject(index, "slug", e.target.value)}
                  className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm font-mono dark:bg-zinc-800"
                />
              </div>
              <div className="rounded-md border border-dashed p-3">
                <button
                  type="button"
                  onClick={() => setProjectAdvancedOpen((prev) => ({ ...prev, [index]: !prev[index] }))}
                  className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  aria-expanded={Boolean(projectAdvancedOpen[index])}
                >
                  Advanced project details
                </button>
                {projectAdvancedOpen[index] && (
                  <div className="mt-3">
                    <label htmlFor={`project-workspace-${index}`} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Local folder override</label>
                    <input
                      id={`project-workspace-${index}`}
                      placeholder="Optional folder for agent work"
                      value={project.workspacePath}
                      onChange={(e) => updateProject(index, "workspacePath", e.target.value)}
                      className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm dark:bg-zinc-800"
                    />
                    <p className="mt-1 text-xs text-zinc-400">Optional. Leave this blank unless an operator gave you a specific folder to use.</p>
                  </div>
                )}
              </div>
            </div>
          ))}

          <button onClick={addProject} className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
            + Add Project
          </button>

          {state.projects.length === 0 && (
            <p className="text-xs text-zinc-400">No projects added yet.</p>
          )}
        </section>
      )}

      {step === REVIEW_STEP && (
        <section className="space-y-4 rounded-lg border p-6" aria-labelledby="review-step-title">
          <div>
            <h2 id="review-step-title" className="text-lg font-medium">Review and launch</h2>
            <p className="text-sm text-zinc-500">Review the hive, runtime choices, connectors, projects, and first goal before creation.</p>
          </div>
          <div className="space-y-3 text-sm">
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium">{state.name}</p>
              <p className="text-zinc-500">{state.type} · Hive address: {hiveAddress}</p>
              <p className="mt-1 text-zinc-500">Mission: {state.mission ? "provided" : "not provided"}</p>
              <p className="text-zinc-500">First goal: {state.initialGoal ? "provided" : "not provided"}</p>
            </div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium mb-1">Runtime changes</p>
              {Object.entries(state.roleOverrides).length === 0 ? (
                <p className="text-zinc-400">Using role defaults.</p>
              ) : (
                Object.entries(state.roleOverrides).map(([slug, override]) => (
                  <p key={slug} className="text-zinc-500">
                    {slug}: {override.adapter ? ADAPTER_LABELS[override.adapter] ?? override.adapter : "default"} / {override.model ?? "default"}
                  </p>
                ))
              )}
            </div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium mb-1">Working preferences</p>
              <p className="text-zinc-500">Agents at once: {state.operatingPreferences.maxConcurrentAgents}</p>
              <p className="text-zinc-500">Looks for useful work: {state.operatingPreferences.proactiveWork ? "yes" : "paused"}</p>
              <p className="text-zinc-500">Memory search: {state.operatingPreferences.memorySearch ? "ready" : "not yet"}</p>
              <p className="text-zinc-500">Request sorting: {requestSortingLabel(state.operatingPreferences.requestSorting)}</p>
            </div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="font-medium mb-1">Connected services</p>
              {connectors.length === 0 ? (
                <p className="text-zinc-400">No services selected. Add connectors later in Settings.</p>
              ) : (
                connectors
                  .filter((connector) => state.connectorSelections[connector.slug])
                  .map((connector) => (
                    <p key={connector.slug} className="text-zinc-500">
                      {connector.name}: {connectorStatusLabel(state.connectorSelections[connector.slug])}
                      {connector.requiresDispatcherRestart && state.connectorSelections[connector.slug] === "configured" ? " · activation requires dispatcher restart" : ""}
                    </p>
                  ))
              )}
              {connectors.some((connector) => state.connectorSelections[connector.slug]) ? null : (
                <p className="text-zinc-400">All connectors skipped for now.</p>
              )}
            </div>
            {hasProjectsStep && (
              <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
                <p className="font-medium mb-1">Projects ({state.projects.filter((project) => project.name && project.slug).length})</p>
                {state.projects.filter((project) => project.name && project.slug).map((project, index) => (
                  <p key={index} className="text-zinc-500">
                    {project.name} ({project.slug}){project.workspacePath ? " · advanced folder saved" : ""}
                  </p>
                ))}
                {state.projects.filter((project) => project.name && project.slug).length === 0 && (
                  <p className="text-zinc-400">No projects configured.</p>
                )}
              </div>
            )}
          </div>
          {setupStatus && <p className="text-sm text-zinc-500">{setupStatus}</p>}
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error} Nothing has been marked complete. You can fix the issue and try again.
            </p>
          )}
        </section>
      )}

      <div className="flex justify-between">
        <button
          onClick={goBack}
          disabled={isFirstStep}
          className="rounded-md border px-4 py-2 text-sm disabled:opacity-30 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Back
        </button>
        {!isLastStep ? (
          <button
            onClick={goNext}
            disabled={step === 1 && !state.name}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Next
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-green-600 px-6 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
          >
            {submitting ? "Setting up..." : error ? "Retry setup" : "Create Hive"}
          </button>
        )}
      </div>
    </div>
  );
}

function RadioChoice({
  name,
  checked,
  onChange,
  title,
  description,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-md border p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-5 text-zinc-500">{description}</span>
      </span>
    </label>
  );
}

function requestSortingLabel(preset: RequestSortingPreset): string {
  if (preset === "direct") return "prefer direct tasks";
  if (preset === "goals") return "prefer goals";
  return "balanced";
}

function EaDiscordSetup({
  connector,
  fields,
  displayName,
  selection,
  onSelect,
  onFieldChange,
  onDisplayNameChange,
}: {
  connector: Connector;
  fields: Record<string, string>;
  displayName: string;
  selection?: "skipped" | "configure-later" | "configured";
  onSelect: (slug: string, selection: "skipped" | "configure-later" | "configured") => void;
  onFieldChange: (slug: string, key: string, value: string) => void;
  onDisplayNameChange: (slug: string, value: string) => void;
}) {
  const configured = connector.setupFields.every((field) => !field.required || fields[field.key]);
  const applicationField = connector.setupFields.find((field) => field.key === "applicationId");
  const channelField = connector.setupFields.find((field) => field.key === "channelId");
  const tokenField = connector.setupFields.find((field) => field.key === "botToken");
  const optionalFields = connector.setupFields.filter((field) => !["applicationId", "channelId", "botToken"].includes(field.key));

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-zinc-50 p-4 dark:bg-zinc-900">
        <div className="flex items-start gap-3">
          <span className="text-2xl" aria-hidden="true">{connector.icon ?? "*"}</span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{connector.name}</p>
            <p className="text-sm text-zinc-500">Add the Discord app details now, or do it later from Settings.</p>
            {selection && <p className="mt-1 text-xs text-zinc-500">Status: {connectorStatusLabel(selection)}</p>}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="ea-display-name" className="text-sm font-medium">Name shown in HiveWright</label>
          <input
            id="ea-display-name"
            value={displayName}
            onChange={(e) => onDisplayNameChange(connector.slug, e.target.value)}
            placeholder={connector.name}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          />
        </div>

        {applicationField && (
          <ConnectorFieldInput
            connector={connector}
            field={applicationField}
            fields={fields}
            onFieldChange={onFieldChange}
          />
        )}

        {channelField && (
          <ConnectorFieldInput
            connector={connector}
            field={{
              ...channelField,
              label: "Allowed Discord channel ID",
              helpText: "The EA will listen in this channel, plus direct messages. You can change it later.",
            }}
            fields={fields}
            onFieldChange={onFieldChange}
          />
        )}

        {tokenField && (
          <ConnectorFieldInput
            connector={connector}
            field={tokenField}
            fields={fields}
            onFieldChange={onFieldChange}
          />
        )}

        {optionalFields.length > 0 && (
          <details className="rounded-md border border-dashed p-3">
            <summary className="cursor-pointer text-sm font-medium">Optional Discord settings</summary>
            <div className="mt-3 space-y-3">
              {optionalFields.map((field) => (
                <ConnectorFieldInput
                  key={field.key}
                  connector={connector}
                  field={field}
                  fields={fields}
                  onFieldChange={onFieldChange}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
        <p className="font-medium">Test message</p>
        <p className="mt-1">Testing is available after this setup is saved, because HiveWright needs to install the EA before it can send the Discord check.</p>
        <button
          type="button"
          disabled
          className="mt-3 rounded-md border border-amber-300 px-3 py-1.5 text-xs opacity-60 dark:border-amber-700"
        >
          Test after setup
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onSelect(connector.slug, configured ? "configured" : "configure-later")}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {configured ? "Use this EA setup" : "Save for later"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(connector.slug, "configure-later")}
          className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          I&apos;ll do this later
        </button>
      </div>
    </div>
  );
}

function ConnectorCard({
  connector,
  expanded,
  fields,
  displayName,
  selection,
  onToggle,
  onSelect,
  onFieldChange,
  onDisplayNameChange,
}: {
  connector: Connector;
  expanded: boolean;
  fields: Record<string, string>;
  displayName: string;
  selection?: "skipped" | "configure-later" | "configured";
  onToggle: () => void;
  onSelect: (slug: string, selection: "skipped" | "configure-later" | "configured") => void;
  onFieldChange: (slug: string, key: string, value: string) => void;
  onDisplayNameChange: (slug: string, value: string) => void;
}) {
  const configured = connector.setupFields.length > 0
    ? connector.setupFields.every((field) => !field.required || fields[field.key])
    : true;
  const isOAuth = connector.authType === "oauth2";

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden="true">{connector.icon ?? "*"}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{connector.name}</p>
          <p className="text-xs text-zinc-500">{connectorDescription(connector)}</p>
          {connector.requiresDispatcherRestart && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">Activation requires a dispatcher restart after install.</p>
          )}
          {selection && (
            <p className="mt-1 text-xs text-zinc-500">Status: {connectorStatusLabel(selection)}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {isOAuth ? (
          <button
            type="button"
            onClick={() => onSelect(connector.slug, "configure-later")}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Connect after launch
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onToggle();
              onSelect(connector.slug, configured ? "configured" : "configure-later");
            }}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {connector.authType === "none" ? "Add connector" : `Configure ${connector.name}`}
          </button>
        )}
        <button
          type="button"
          onClick={() => onSelect(connector.slug, "skipped")}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Skip
        </button>
      </div>

      {isOAuth && (
        <p className="mt-2 text-xs text-zinc-500">
          You can finish this connection from Settings after the hive is created.
        </p>
      )}

      {expanded && !isOAuth && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <div>
            <label htmlFor={`connector-display-${connector.slug}`} className="text-xs text-zinc-600 dark:text-zinc-400">Display name</label>
            <input
              id={`connector-display-${connector.slug}`}
              value={displayName}
              onChange={(e) => onDisplayNameChange(connector.slug, e.target.value)}
              placeholder={connector.name}
              className="mt-1 w-full rounded border px-2 py-1 text-sm dark:bg-zinc-800"
            />
          </div>
          {connector.setupFields.map((field) => (
            <ConnectorFieldInput
              key={field.key}
              connector={connector}
              field={field}
              fields={fields}
              onFieldChange={onFieldChange}
              compact
            />
          ))}
          <button
            type="button"
            onClick={() => onSelect(connector.slug, configured ? "configured" : "configure-later")}
            className="rounded-md border px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            {configured ? "Use this setup" : "Save for later"}
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectorFieldInput({
  connector,
  field,
  fields,
  onFieldChange,
  compact = false,
}: {
  connector: Connector;
  field: SetupField;
  fields: Record<string, string>;
  onFieldChange: (slug: string, key: string, value: string) => void;
  compact?: boolean;
}) {
  const inputId = `connector-${connector.slug}-${field.key}`;
  const labelClassName = compact
    ? "text-xs text-zinc-600 dark:text-zinc-400"
    : "text-sm font-medium";
  const controlClassName = compact
    ? "mt-1 w-full rounded border px-2 py-1 text-sm dark:bg-zinc-800"
    : "mt-1 w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800";

  return (
    <div>
      <label htmlFor={inputId} className={labelClassName}>
        {field.label}
        {field.required && <span className="text-red-500"> *</span>}
      </label>
      {field.type === "textarea" ? (
        <textarea
          id={inputId}
          value={fields[field.key] ?? ""}
          onChange={(e) => onFieldChange(connector.slug, field.key, e.target.value)}
          placeholder={field.placeholder}
          rows={compact ? 2 : 3}
          className={controlClassName}
        />
      ) : (
        <input
          id={inputId}
          type={field.type === "password" ? "password" : "text"}
          value={fields[field.key] ?? ""}
          onChange={(e) => onFieldChange(connector.slug, field.key, e.target.value)}
          placeholder={field.placeholder}
          className={controlClassName}
        />
      )}
      {field.helpText && <p className="mt-1 text-xs text-zinc-400">{field.helpText}</p>}
    </div>
  );
}

function normalizeAdapter(adapter: string) {
  if (adapter === "mistral") return adapter;
  return ADAPTER_LABELS[adapter] ? adapter : "codex";
}

function connectorStatusLabel(selection?: "skipped" | "configure-later" | "configured") {
  switch (selection) {
    case "configured":
      return "configured for install during launch";
    case "configure-later":
      return "set aside for Settings after launch";
    case "skipped":
      return "skipped";
    default:
      return "not selected";
  }
}

function connectorDescription(connector: Connector) {
  if (connector.slug === "ea-discord") {
    return "Hosts this hive's Executive Assistant on Discord through the connector system.";
  }
  return connector.description.replace(/\s*Replaces the legacy gateway EA\./g, "");
}
