"use client";
import { useEffect, useState, useCallback } from "react";
import { useHiveContext } from "@/components/hive-context";
import {
  DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
  EA_REPLAY_ADAPTER_TYPE,
  EA_REPLAY_MESSAGE_LIMIT_KEY,
  MAX_EA_REPLAY_MESSAGE_LIMIT,
  MIN_EA_REPLAY_MESSAGE_LIMIT,
  asEaReplayMessageLimit,
} from "@/ea/replay-settings";

type Credential = {
  id: string;
  hiveId: string | null;
  name: string;
  key: string;
  rolesAllowed: string[] | null;
  expiresAt: string | null;
};

type CredentialKind = "single" | "userpass";

type NotificationPref = {
  id: string;
  hiveId: string;
  channel: string;
  config: Record<string, string>;
  priorityFilter: string;
  enabled: boolean;
  createdAt: string;
};

type NewNotifForm = {
  channel: "discord" | "telegram" | "email";
  priorityFilter: "all" | "urgent";
  webhookUrl: string;
  botToken: string;
  chatId: string;
  email: string;
};

const MODEL_EFFICIENCY_DEFAULTS = {
  avgCostCentsThreshold: 50,
  minCompletionsThreshold: 5,
};

type ModelEfficiencySettings = typeof MODEL_EFFICIENCY_DEFAULTS;

const MODEL_EFFICIENCY_ADAPTER_TYPE = "model-efficiency";
const QUALITY_CONTROLS_ADAPTER_TYPE = "quality-controls";

const QUALITY_DEFAULTS = {
  ownerFeedbackSampleRate: 0.08,
  aiPeerFeedbackSampleRate: 0.5,
  defaultQualityFloor: 0.7,
};

type EaReplaySettings = {
  replayMessageLimit: number;
};

type SetupHealth = {
  hiveWorkspaceRoot: string;
  envKey: string;
  envFilePath: string;
  restartRequired: boolean;
  restartMessage?: string;
};

type RoleQualityRow = {
  roleSlug: string;
  qualityScore: number;
  basis: string;
  qualityFloor: number;
  ownerPinned: boolean;
};

const panelClass =
  "rounded-lg border border-amber-200/55 bg-card/92 p-4 shadow-[0_18px_55px_rgba(62,43,15,0.08)] dark:border-white/[0.08] dark:bg-card/82 dark:shadow-black/20";
const tableWrapClass =
  "overflow-x-auto rounded-lg border border-amber-200/55 bg-card/88 dark:border-white/[0.08] dark:bg-card/75";
const tableHeadClass =
  "bg-amber-100/60 text-amber-950 dark:bg-white/[0.035] dark:text-zinc-300";
const rowClass = "border-t border-amber-200/55 dark:border-white/[0.08]";
const inputClass =
  "w-full rounded-md border border-amber-200/70 bg-background px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:border-white/[0.1] dark:bg-zinc-950/35";
const compactInputClass =
  "w-24 rounded-md border border-amber-200/70 bg-background px-2 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:border-white/[0.1] dark:bg-zinc-950/35";
const primaryButtonClass =
  "rounded-md bg-amber-300 px-4 py-2 text-sm font-medium text-zinc-950 shadow-[0_10px_24px_rgba(229,154,27,0.16)] transition-colors hover:bg-amber-200 focus-visible:ring-2 focus-visible:ring-amber-500/45 disabled:opacity-50 dark:bg-amber-300 dark:text-zinc-950 dark:hover:bg-amber-200";
const secondaryButtonClass =
  "rounded-md border border-amber-200/70 px-4 py-2 text-sm transition-colors hover:bg-amber-100/70 focus-visible:ring-2 focus-visible:ring-amber-500/45 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]";
const smallSecondaryButtonClass =
  "rounded-md border border-amber-200/70 px-3 py-1.5 text-xs transition-colors hover:bg-amber-100/70 focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:border-white/[0.1] dark:hover:bg-white/[0.06]";

export default function SettingsPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loadingCreds, setLoadingCreds] = useState(true);
  const [credKind, setCredKind] = useState<CredentialKind>("single");
  const [newCred, setNewCred] = useState({
    hiveId: "",  // empty string = shared across all hives
    name: "",
    key: "",
    value: "",
    username: "",  // only used when credKind === "userpass"
    rolesAllowed: "",
    expiresAt: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  // Notification channels
  const { selected: selectedHive, hives: hiveList } = useHiveContext();

  // Default the new-cred form's hiveId to the currently selected hive once
  // the context loads, so the dashboard's hive switcher and this form stay
  // in sync. The user can still override to "Shared (all hives)".
  useEffect(() => {
    if (selectedHive?.id && !newCred.hiveId) {
      setNewCred((prev) => ({ ...prev, hiveId: selectedHive.id }));
    }
    // intentional: only re-run when the selected hive id changes; keeping
    // newCred out of deps avoids overwriting the user's explicit choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHive?.id]);

  // Look up a hive's display name by id for the credentials table.
  const hiveNameById = (id: string | null) => {
    if (!id) return "Shared";
    const found = hiveList.find((h) => h.id === id);
    return found?.name ?? id.slice(0, 8);
  };
  const [notifPrefs, setNotifPrefs] = useState<NotificationPref[]>([]);
  const [loadingNotifs, setLoadingNotifs] = useState(false);
  const [notifForm, setNotifForm] = useState<NewNotifForm>({
    channel: "discord", priorityFilter: "all",
    webhookUrl: "", botToken: "", chatId: "", email: "",
  });
  const [addingNotif, setAddingNotif] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [notifSuccess, setNotifSuccess] = useState<string | null>(null);
  const [testingNotif, setTestingNotif] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [modelEfficiency, setModelEfficiency] = useState<ModelEfficiencySettings>(
    MODEL_EFFICIENCY_DEFAULTS,
  );
  const [modelEfficiencyLoaded, setModelEfficiencyLoaded] = useState(false);
  const [modelEfficiencySaving, setModelEfficiencySaving] = useState(false);
  const [modelEfficiencySaved, setModelEfficiencySaved] = useState(false);
  const [modelEfficiencyError, setModelEfficiencyError] = useState<string | null>(null);
  const [eaReplay, setEaReplay] = useState<EaReplaySettings>({
    replayMessageLimit: DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
  });
  const [eaReplayLoaded, setEaReplayLoaded] = useState(false);
  const [eaReplaySaving, setEaReplaySaving] = useState(false);
  const [eaReplaySaved, setEaReplaySaved] = useState(false);
  const [eaReplayError, setEaReplayError] = useState<string | null>(null);
  const [qualitySettings, setQualitySettings] = useState({
    ownerFeedbackSampleRate: QUALITY_DEFAULTS.ownerFeedbackSampleRate,
    aiPeerFeedbackSampleRate: QUALITY_DEFAULTS.aiPeerFeedbackSampleRate,
    defaultQualityFloor: QUALITY_DEFAULTS.defaultQualityFloor,
    roleQualityFloors: {} as Record<string, number>,
  });
  const [roleQualityRows, setRoleQualityRows] = useState<RoleQualityRow[]>([]);
  const [qualityLoaded, setQualityLoaded] = useState(false);
  const [qualitySaving, setQualitySaving] = useState(false);
  const [qualitySaved, setQualitySaved] = useState(false);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [qualitySamplingSource, setQualitySamplingSource] =
    useState<"hive" | "global" | "default">("default");
  const [setupHealth, setSetupHealth] = useState<SetupHealth | null>(null);
  const [workspaceRootDraft, setWorkspaceRootDraft] = useState("");
  const [workspaceRootSaving, setWorkspaceRootSaving] = useState(false);
  const [workspaceRootSaved, setWorkspaceRootSaved] = useState(false);
  const [workspaceRootError, setWorkspaceRootError] = useState<string | null>(null);

  const loadModelEfficiencySettings = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/adapter-config?adapterType=${MODEL_EFFICIENCY_ADAPTER_TYPE}`,
      );
      const body = await res.json();
      const row = (body.data || []).find(
        (c: { adapterType: string }) =>
          c.adapterType === MODEL_EFFICIENCY_ADAPTER_TYPE,
      );
      const config = row?.config ?? {};
      setModelEfficiency({
        avgCostCentsThreshold:
          config.efficiency_avg_cost_cents_threshold ??
          MODEL_EFFICIENCY_DEFAULTS.avgCostCentsThreshold,
        minCompletionsThreshold:
          config.efficiency_min_completions_threshold ??
          MODEL_EFFICIENCY_DEFAULTS.minCompletionsThreshold,
      });
    } finally {
      setModelEfficiencyLoaded(true);
    }
  }, []);

  const loadEaReplaySettings = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/adapter-config?adapterType=${EA_REPLAY_ADAPTER_TYPE}`,
      );
      const body = await res.json();
      const row = (body.data || []).find(
        (c: { adapterType: string }) => c.adapterType === EA_REPLAY_ADAPTER_TYPE,
      );
      const config = row?.config ?? {};
      setEaReplay({
        replayMessageLimit: asEaReplayMessageLimit(
          config[EA_REPLAY_MESSAGE_LIMIT_KEY],
        ),
      });
    } finally {
      setEaReplayLoaded(true);
    }
  }, []);

  const loadQualitySettings = useCallback(async () => {
    if (!selectedHive?.id) {
      setQualityLoaded(true);
      return;
    }
    try {
      const [ownerFeedbackRes, roleQualityRes] = await Promise.all([
        fetch(`/api/quality/config?hiveId=${selectedHive.id}`),
        fetch(`/api/quality/roles?hiveId=${selectedHive.id}`),
      ]);
      const ownerFeedbackBody = await ownerFeedbackRes.json();
      const roleQualityBody = await roleQualityRes.json();
      const ownerFeedbackConfig = ownerFeedbackBody.data?.effective ?? {};
      const qualityData = roleQualityBody.data ?? {};
      setQualitySettings({
        ownerFeedbackSampleRate:
          ownerFeedbackConfig.owner_feedback_sample_rate ??
          QUALITY_DEFAULTS.ownerFeedbackSampleRate,
        aiPeerFeedbackSampleRate:
          ownerFeedbackConfig.ai_peer_feedback_sample_rate ??
          QUALITY_DEFAULTS.aiPeerFeedbackSampleRate,
        defaultQualityFloor:
          qualityData.defaultQualityFloor ?? QUALITY_DEFAULTS.defaultQualityFloor,
        roleQualityFloors: qualityData.roleQualityFloors ?? {},
      });
      setQualitySamplingSource(ownerFeedbackBody.data?.source ?? "default");
      setRoleQualityRows(qualityData.roles ?? []);
    } finally {
      setQualityLoaded(true);
    }
  }, [selectedHive?.id]);

  const fetchCredentials = () => {
    fetch("/api/credentials")
      .then((r) => r.json())
      .then((b) => setCredentials(b.data || []))
      .finally(() => setLoadingCreds(false));
  };

  useEffect(() => {
    fetchCredentials();
  }, []);

  useEffect(() => {
    loadModelEfficiencySettings();
  }, [loadModelEfficiencySettings]);

  useEffect(() => {
    loadEaReplaySettings();
  }, [loadEaReplaySettings]);

  useEffect(() => {
    loadQualitySettings();
  }, [loadQualitySettings]);

  useEffect(() => {
    fetch("/api/setup-health")
      .then((r) => r.json())
      .then((body) => {
        if (!body.data) return;
        setSetupHealth(body.data);
        setWorkspaceRootDraft(body.data.hiveWorkspaceRoot ?? "");
      })
      .catch(() => {
        setWorkspaceRootError("Could not load setup health.");
      });
  }, []);

  const saveWorkspaceRoot = async () => {
    const nextRoot = workspaceRootDraft.trim();
    if (!nextRoot) {
      setWorkspaceRootError("Hive workspace root is required.");
      return;
    }

    setWorkspaceRootSaving(true);
    setWorkspaceRootSaved(false);
    setWorkspaceRootError(null);
    try {
      const res = await fetch("/api/setup-health", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveWorkspaceRoot: nextRoot }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to save hive workspace root.");
      setSetupHealth(body.data);
      setWorkspaceRootDraft(body.data.hiveWorkspaceRoot ?? nextRoot);
      setWorkspaceRootSaved(true);
    } catch (err) {
      setWorkspaceRootError(err instanceof Error ? err.message : "Network error");
    } finally {
      setWorkspaceRootSaving(false);
    }
  };

  const saveModelEfficiencySettings = async () => {
    const avg = Number(modelEfficiency.avgCostCentsThreshold);
    const min = Number(modelEfficiency.minCompletionsThreshold);

    if (!Number.isInteger(avg) || avg < 1 || !Number.isInteger(min) || min < 1) {
      setModelEfficiencyError("Both model efficiency thresholds must be positive integers.");
      return;
    }

    setModelEfficiencySaving(true);
    setModelEfficiencyError(null);
    setModelEfficiencySaved(false);

    try {
      const res = await fetch("/api/adapter-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adapterType: MODEL_EFFICIENCY_ADAPTER_TYPE,
          config: {
            efficiency_avg_cost_cents_threshold: avg,
            efficiency_min_completions_threshold: min,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to save model efficiency settings");
      }
      setModelEfficiency({ avgCostCentsThreshold: avg, minCompletionsThreshold: min });
      setModelEfficiencySaved(true);
      setTimeout(() => setModelEfficiencySaved(false), 2000);
    } catch (err) {
      setModelEfficiencyError(err instanceof Error ? err.message : "Network error");
    } finally {
      setModelEfficiencySaving(false);
    }
  };

  const saveEaReplaySettings = async () => {
    const limit = Number(eaReplay.replayMessageLimit);

    if (
      !Number.isInteger(limit) ||
      limit < MIN_EA_REPLAY_MESSAGE_LIMIT ||
      limit > MAX_EA_REPLAY_MESSAGE_LIMIT
    ) {
      setEaReplayError(
        `EA replay window must be a whole number from ${MIN_EA_REPLAY_MESSAGE_LIMIT} to ${MAX_EA_REPLAY_MESSAGE_LIMIT}.`,
      );
      return;
    }

    setEaReplaySaving(true);
    setEaReplayError(null);
    setEaReplaySaved(false);

    try {
      const res = await fetch("/api/adapter-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adapterType: EA_REPLAY_ADAPTER_TYPE,
          config: {
            [EA_REPLAY_MESSAGE_LIMIT_KEY]: limit,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to save EA replay settings");
      }
      setEaReplay({ replayMessageLimit: limit });
      setEaReplaySaved(true);
      setTimeout(() => setEaReplaySaved(false), 2000);
    } catch (err) {
      setEaReplayError(err instanceof Error ? err.message : "Network error");
    } finally {
      setEaReplaySaving(false);
    }
  };

  const saveQualitySettings = async () => {
    const sampleRate = Number(qualitySettings.ownerFeedbackSampleRate);
    const aiPeerSampleRate = Number(qualitySettings.aiPeerFeedbackSampleRate);
    const defaultFloor = Number(qualitySettings.defaultQualityFloor);
    const roleQualityFloors = Object.fromEntries(
      Object.entries(qualitySettings.roleQualityFloors)
        .map(([role, value]) => [role, Number(value)] as const)
        .filter(([, value]) => Number.isFinite(value) && value >= 0 && value <= 1),
    );

    if (
      !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1 ||
      !Number.isFinite(aiPeerSampleRate) || aiPeerSampleRate < 0 || aiPeerSampleRate > 1 ||
      !Number.isFinite(defaultFloor) || defaultFloor < 0 || defaultFloor > 1
    ) {
      setQualityError("Sample rate and quality floors must be numbers from 0 to 1.");
      return;
    }

    setQualitySaving(true);
    setQualityError(null);
    setQualitySaved(false);
    try {
      const [ownerFeedbackRes, qualityRes] = await Promise.all([
        fetch("/api/quality/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hiveId: selectedHive?.id,
            ownerFeedbackSampleRate: sampleRate,
            aiPeerFeedbackSampleRate: aiPeerSampleRate,
          }),
        }),
        fetch("/api/adapter-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hiveId: selectedHive?.id ?? null,
            adapterType: QUALITY_CONTROLS_ADAPTER_TYPE,
            config: {
              default_quality_floor: defaultFloor,
              role_quality_floors: roleQualityFloors,
            },
          }),
        }),
      ]);
      if (!ownerFeedbackRes.ok || !qualityRes.ok) {
        throw new Error("Failed to save quality settings");
      }
      setQualitySettings({
        ownerFeedbackSampleRate: sampleRate,
        aiPeerFeedbackSampleRate: aiPeerSampleRate,
        defaultQualityFloor: defaultFloor,
        roleQualityFloors,
      });
      setQualitySaved(true);
      setTimeout(() => setQualitySaved(false), 2000);
      await loadQualitySettings();
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : "Network error");
    } finally {
      setQualitySaving(false);
    }
  };

  const setOwnerPinned = async (roleSlug: string, ownerPinned: boolean) => {
    setRoleQualityRows((rows) =>
      rows.map((row) => row.roleSlug === roleSlug ? { ...row, ownerPinned } : row),
    );
    const res = await fetch("/api/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: roleSlug, ownerPinned }),
    });
    if (!res.ok) {
      setQualityError(`Failed to update owner pin for ${roleSlug}`);
      await loadQualitySettings();
    }
  };

  const [deletingCredId, setDeletingCredId] = useState<string | null>(null);
  const [deleteBlock, setDeleteBlock] = useState<{
    credId: string;
    blockedBy: { id: string; connectorSlug: string; displayName: string }[];
  } | null>(null);

  const deleteCredentialAction = async (credId: string, force: boolean) => {
    setDeletingCredId(credId);
    setCredError(null);
    try {
      const url = force
        ? `/api/credentials/${credId}?force=true`
        : `/api/credentials/${credId}`;
      const res = await fetch(url, { method: "DELETE" });
      if (res.status === 409) {
        const body = await res.json();
        setDeleteBlock({ credId, blockedBy: body.blockedBy ?? [] });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCredError(body.error || `Delete failed (${res.status})`);
        return;
      }
      setDeleteBlock(null);
      fetchCredentials();
    } catch {
      setCredError("Network error during delete");
    } finally {
      setDeletingCredId(null);
    }
  };

  const handleDeleteClick = (credId: string, credKey: string) => {
    if (!confirm(`Delete credential "${credKey}"? This cannot be undone.`)) return;
    deleteCredentialAction(credId, false);
  };

  const addCredential = async () => {
    if (!newCred.name || !newCred.key || !newCred.value) return;
    if (credKind === "userpass" && !newCred.username) {
      setCredError("Username is required for username + password credentials");
      return;
    }
    setSubmitting(true);
    setCredError(null);
    const roles = newCred.rolesAllowed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const baseKey = newCred.key.toUpperCase().replace(/\s+/g, "_");

    // For "userpass" we POST two paired credentials so loaders can ask for
    // <BASE>_USERNAME / <BASE>_PASSWORD individually.
    const payloads =
      credKind === "userpass"
        ? [
            {
              key: `${baseKey}_USERNAME`,
              value: newCred.username,
              name: `${newCred.name} (username)`,
            },
            {
              key: `${baseKey}_PASSWORD`,
              value: newCred.value,
              name: `${newCred.name} (password)`,
            },
          ]
        : [{ key: baseKey, value: newCred.value, name: newCred.name }];

    try {
      for (const p of payloads) {
        const res = await fetch("/api/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hiveId: newCred.hiveId || null,
            name: p.name,
            key: p.key,
            value: p.value,
            rolesAllowed: roles,
            expiresAt: newCred.expiresAt || null,
          }),
        });
        if (!res.ok) {
          const json = await res.json();
          throw new Error(json.error || `Failed to add ${p.key}`);
        }
      }
      setNewCred({
        hiveId: newCred.hiveId,  // keep selected hive sticky
        name: "",
        key: "",
        value: "",
        username: "",
        rolesAllowed: "",
        expiresAt: "",
      });
      fetchCredentials();
    } catch (err: unknown) {
      setCredError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const fetchNotifPrefs = useCallback(async (bizId: string) => {
    setLoadingNotifs(true);
    try {
      const res = await fetch(`/api/notifications/preferences?hiveId=${bizId}`);
      const json = await res.json();
      setNotifPrefs(json.data || []);
    } catch {
      setNotifPrefs([]);
    } finally {
      setLoadingNotifs(false);
    }
  }, []);

  useEffect(() => {
    if (selectedHive?.id) {
      fetchNotifPrefs(selectedHive.id);
    } else {
      setNotifPrefs([]);
    }
  }, [selectedHive?.id, fetchNotifPrefs]);

  const addNotifPref = async () => {
    if (!selectedHive) return;
    setAddingNotif(true);
    setNotifError(null);
    setNotifSuccess(null);

    let config: Record<string, string> = {};
    if (notifForm.channel === "discord") {
      if (!notifForm.webhookUrl) { setNotifError("Webhook URL is required"); setAddingNotif(false); return; }
      config = { webhookUrl: notifForm.webhookUrl };
    } else if (notifForm.channel === "telegram") {
      if (!notifForm.botToken || !notifForm.chatId) { setNotifError("Bot token and chat ID are required"); setAddingNotif(false); return; }
      config = { botToken: notifForm.botToken, chatId: notifForm.chatId };
    } else if (notifForm.channel === "email") {
      if (!notifForm.email) { setNotifError("Email address is required"); setAddingNotif(false); return; }
      config = { email: notifForm.email };
    }

    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId: selectedHive.id,
          channel: notifForm.channel,
          config,
          priorityFilter: notifForm.priorityFilter,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        setNotifError(json.error || "Failed to add channel");
      } else {
        setNotifSuccess("Notification channel added.");
        setNotifForm({ channel: "discord", priorityFilter: "all", webhookUrl: "", botToken: "", chatId: "", email: "" });
        fetchNotifPrefs(selectedHive.id);
      }
    } catch {
      setNotifError("Network error");
    } finally {
      setAddingNotif(false);
    }
  };

  const deleteNotifPref = async (id: string) => {
    if (!selectedHive) return;
    try {
      await fetch(`/api/notifications/preferences/${id}`, { method: "DELETE" });
      fetchNotifPrefs(selectedHive.id);
    } catch { /* ignore */ }
  };

  const sendTestNotif = async () => {
    if (!selectedHive) return;
    setTestingNotif(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: selectedHive.id }),
      });
      const json = await res.json();
      if (res.ok) {
        setTestResult("Test notification sent successfully.");
      } else {
        setTestResult(json.error || "Failed to send test notification.");
      }
    } catch {
      setTestResult("Network error sending test notification.");
    } finally {
      setTestingNotif(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="hive-honey-glow">
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Setup health</h2>
          <p className="text-sm text-zinc-500">
            Host-level defaults used when HiveWright creates new hive workspaces.
          </p>
        </div>

        <div className={`${panelClass} space-y-3`}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">
                Hive workspace root
              </label>
              <input
                value={workspaceRootDraft}
                onChange={(e) => setWorkspaceRootDraft(e.target.value)}
                placeholder={setupHealth?.hiveWorkspaceRoot ?? "Loading..."}
                className={`${inputClass} font-mono`}
              />
              <p className="text-xs text-zinc-500">
                Writes <code className="font-mono">{setupHealth?.envKey ?? "HIVES_WORKSPACE_ROOT"}</code>{" "}
                in <code className="font-mono">{setupHealth?.envFilePath ?? ".env"}</code>.
              </p>
            </div>
            <div className="flex items-end">
              <button
                onClick={saveWorkspaceRoot}
                disabled={workspaceRootSaving || !workspaceRootDraft.trim()}
                className={primaryButtonClass}
              >
                {workspaceRootSaving ? "Saving..." : "Save root"}
              </button>
            </div>
          </div>
          {workspaceRootError && <p className="text-sm text-red-500">{workspaceRootError}</p>}
          {workspaceRootSaved && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {setupHealth?.restartMessage ?? "Restart the dispatcher and app for the new workspace root to take effect."}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Model efficiency</h2>
          <p className="text-sm text-zinc-500">
            Global thresholds for the weekly model-efficiency sweeper. Changes are
            picked up on the next sweep run; EA replay changes apply to the next turn.
          </p>
        </div>

        <div className={`${panelClass} space-y-4`}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">
                Model efficiency: average cost threshold (cents per task)
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={modelEfficiency.avgCostCentsThreshold}
                disabled={!modelEfficiencyLoaded}
                onChange={(e) =>
                  setModelEfficiency({
                    ...modelEfficiency,
                    avgCostCentsThreshold: Number(e.target.value),
                  })
                }
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">
                Model efficiency: minimum completions before flagging (per 30 days)
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={modelEfficiency.minCompletionsThreshold}
                disabled={!modelEfficiencyLoaded}
                onChange={(e) =>
                  setModelEfficiency({
                    ...modelEfficiency,
                    minCompletionsThreshold: Number(e.target.value),
                  })
                }
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">
                EA replay window (messages)
              </label>
              <input
                type="number"
                min={MIN_EA_REPLAY_MESSAGE_LIMIT}
                max={MAX_EA_REPLAY_MESSAGE_LIMIT}
                step={1}
                value={eaReplay.replayMessageLimit}
                disabled={!eaReplayLoaded}
                onChange={(e) =>
                  setEaReplay({
                    replayMessageLimit: Number(e.target.value),
                  })
                }
                className={inputClass}
              />
              <p className="text-xs text-zinc-500">
                Whole number from {MIN_EA_REPLAY_MESSAGE_LIMIT} to{" "}
                {MAX_EA_REPLAY_MESSAGE_LIMIT}; defaults to{" "}
                {DEFAULT_EA_REPLAY_MESSAGE_LIMIT}.
              </p>
            </div>
          </div>

          {modelEfficiencyError && (
            <p className="text-sm text-red-500">{modelEfficiencyError}</p>
          )}
          {eaReplayError && <p className="text-sm text-red-500">{eaReplayError}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={saveModelEfficiencySettings}
              disabled={!modelEfficiencyLoaded || modelEfficiencySaving}
              className={primaryButtonClass}
            >
              {modelEfficiencySaving
                ? "Saving..."
                : modelEfficiencySaved
                  ? "Saved"
                  : "Save model efficiency settings"}
            </button>
            <button
              onClick={saveEaReplaySettings}
              disabled={!eaReplayLoaded || eaReplaySaving}
              className={secondaryButtonClass}
            >
              {eaReplaySaving
                ? "Saving..."
                : eaReplaySaved
                  ? "Saved"
                  : "Save EA replay settings"}
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Quality controls</h2>
          <p className="text-sm text-zinc-500">
            Owner feedback sampling, role quality floors, and automatic model-swap guardrails.
          </p>
          <p className="text-xs text-zinc-500">
            Sampling values show the effective next-tick config for{" "}
            {selectedHive?.name ?? "the selected hive"} ({qualitySamplingSource}).
          </p>
        </div>

        <div className={`${panelClass} space-y-4`}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">
                Owner feedback sample rate
              </label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={qualitySettings.ownerFeedbackSampleRate}
                disabled={!qualityLoaded}
                onChange={(e) =>
                  setQualitySettings({
                    ...qualitySettings,
                    ownerFeedbackSampleRate: Number(e.target.value),
                  })
                }
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">
                AI peer feedback sample rate
              </label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={qualitySettings.aiPeerFeedbackSampleRate}
                disabled={!qualityLoaded}
                onChange={(e) =>
                  setQualitySettings({
                    ...qualitySettings,
                    aiPeerFeedbackSampleRate: Number(e.target.value),
                  })
                }
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">
                Default quality floor
              </label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={qualitySettings.defaultQualityFloor}
                disabled={!qualityLoaded}
                onChange={(e) =>
                  setQualitySettings({
                    ...qualitySettings,
                    defaultQualityFloor: Number(e.target.value),
                  })
                }
                className={inputClass}
              />
            </div>
          </div>

          <div className={tableWrapClass}>
            <table className="min-w-[640px] w-full text-left text-sm">
              <thead className={`text-xs ${tableHeadClass}`}>
                <tr>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Quality</th>
                  <th className="px-3 py-2 font-medium">Floor</th>
                  <th className="px-3 py-2 font-medium">Owner pinned</th>
                </tr>
              </thead>
              <tbody>
                {roleQualityRows.map((role) => (
                  <tr key={role.roleSlug} className={rowClass}>
                    <td className="px-3 py-2 font-mono text-xs">{role.roleSlug}</td>
                    <td className="px-3 py-2">
                      {role.qualityScore.toFixed(3)}
                      <span className="ml-2 text-xs text-zinc-500">{role.basis}</span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={
                          qualitySettings.roleQualityFloors[role.roleSlug] ??
                          role.qualityFloor
                        }
                        disabled={!qualityLoaded}
                        onChange={(e) =>
                          setQualitySettings({
                            ...qualitySettings,
                            roleQualityFloors: {
                              ...qualitySettings.roleQualityFloors,
                              [role.roleSlug]: Number(e.target.value),
                            },
                          })
                        }
                        className={compactInputClass}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={role.ownerPinned}
                        disabled={!qualityLoaded}
                        onChange={(e) => setOwnerPinned(role.roleSlug, e.target.checked)}
                        className="h-4 w-4 rounded border-amber-200/70 text-amber-500 focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:border-white/[0.12]"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {qualityError && <p className="text-sm text-red-500">{qualityError}</p>}
          <button
            onClick={saveQualitySettings}
            disabled={!qualityLoaded || qualitySaving || !selectedHive?.id}
            className={primaryButtonClass}
          >
            {qualitySaving ? "Saving..." : qualitySaved ? "Saved" : "Save quality controls"}
          </button>
        </div>
      </section>

      {/* Credentials */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Credentials</h2>
          <p className="text-sm text-zinc-500">
            API keys, secrets, and login pairs. Scope each credential to a specific hive
            (or share across all hives). Values are encrypted at rest — never displayed.
          </p>
        </div>

        {deleteBlock && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-400/[0.06]">
            <p className="font-medium text-amber-900 dark:text-amber-200">
              Can&apos;t delete — this credential is wired into{" "}
              {deleteBlock.blockedBy.length} connector install
              {deleteBlock.blockedBy.length === 1 ? "" : "s"}:
            </p>
            <ul className="mt-2 list-disc pl-5 text-xs text-amber-900 dark:text-amber-200">
              {deleteBlock.blockedBy.map((b) => (
                <li key={b.id}>
                  <span className="font-mono">{b.connectorSlug}</span>
                  {b.displayName ? ` — ${b.displayName}` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-900 dark:text-amber-200">
              Remove those installs from <a className="underline" href="/setup/connectors">Connectors</a>{" "}
              first, or force-delete to orphan them (they&apos;ll keep showing up but stop working).
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => deleteCredentialAction(deleteBlock.credId, true)}
                disabled={deletingCredId === deleteBlock.credId}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Force delete anyway
              </button>
              <button
                onClick={() => setDeleteBlock(null)}
                className={smallSecondaryButtonClass}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className={tableWrapClass}>
          <table className="min-w-[760px] w-full text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Key</th>
                <th className="px-4 py-3 text-left font-medium">Hive</th>
                <th className="px-4 py-3 text-left font-medium">Roles Allowed</th>
                <th className="px-4 py-3 text-left font-medium">Expires</th>
                <th className="px-4 py-3 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {loadingCreds && (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-center text-zinc-400">
                    Loading...
                  </td>
                </tr>
              )}
              {!loadingCreds && credentials.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-center text-zinc-400">
                    No credentials configured
                  </td>
                </tr>
              )}
              {credentials.map((c) => (
                <tr key={c.id} className={rowClass}>
                  <td className="px-4 py-3">{c.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500">{c.key}</td>
                  <td className="px-4 py-3 text-xs">
                    {c.hiveId ? (
                      <span>{hiveNameById(c.hiveId)}</span>
                    ) : (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        Shared
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {(c.rolesAllowed ?? []).length > 0
                      ? (c.rolesAllowed ?? []).join(", ")
                      : "all"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDeleteClick(c.id, c.key)}
                      disabled={deletingCredId === c.id}
                      className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50 dark:hover:text-red-400"
                    >
                      {deletingCredId === c.id ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={`${panelClass} space-y-3`}>
          <h3 className="text-sm font-medium">Add Credential</h3>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCredKind("single")}
              className={`rounded-md border px-3 py-1.5 text-xs ${
                credKind === "single"
                  ? "border-amber-300 bg-amber-300 text-zinc-950"
                  : "border-amber-200/70 hover:bg-amber-100/70 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
              }`}
            >
              Single secret (API key, token)
            </button>
            <button
              type="button"
              onClick={() => setCredKind("userpass")}
              className={`rounded-md border px-3 py-1.5 text-xs ${
                credKind === "userpass"
                  ? "border-amber-300 bg-amber-300 text-zinc-950"
                  : "border-amber-200/70 hover:bg-amber-100/70 dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
              }`}
            >
              Username + Password
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">Hive</label>
              <select
                value={newCred.hiveId}
                onChange={(e) => setNewCred({ ...newCred, hiveId: e.target.value })}
                className={inputClass}
              >
                <option value="">Shared (all hives)</option>
                {hiveList.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
            <input
              placeholder={
                credKind === "userpass"
                  ? "Name (e.g. Newbook login)"
                  : "Name (e.g. Anthropic API Key)"
              }
              value={newCred.name}
              onChange={(e) => setNewCred({ ...newCred, name: e.target.value })}
              className={inputClass}
            />
            <input
              placeholder={
                credKind === "userpass"
                  ? "Key prefix (e.g. NEWBOOK)"
                  : "Key (e.g. ANTHROPIC_API_KEY)"
              }
              value={newCred.key}
              onChange={(e) => setNewCred({ ...newCred, key: e.target.value })}
              className={`${inputClass} font-mono`}
            />
            {credKind === "userpass" ? (
              <input
                placeholder="Username"
                value={newCred.username}
                onChange={(e) => setNewCred({ ...newCred, username: e.target.value })}
                className={inputClass}
              />
            ) : (
              <div />
            )}
            <input
              placeholder={credKind === "userpass" ? "Password" : "Value (secret)"}
              type="password"
              value={newCred.value}
              onChange={(e) => setNewCred({ ...newCred, value: e.target.value })}
              className={inputClass}
            />
            <input
              placeholder="Roles (comma-separated, empty = all)"
              value={newCred.rolesAllowed}
              onChange={(e) => setNewCred({ ...newCred, rolesAllowed: e.target.value })}
              className={inputClass}
            />
            <div className="space-y-1">
              <label className="block text-xs text-zinc-500">Expires (optional)</label>
              <input
                type="date"
                value={newCred.expiresAt}
                onChange={(e) => setNewCred({ ...newCred, expiresAt: e.target.value })}
                className={inputClass}
              />
            </div>
          </div>

          {credKind === "userpass" && newCred.key && (
            <p className="text-xs text-zinc-500">
              Will store as{" "}
              <code className="font-mono">
                {newCred.key.toUpperCase().replace(/\s+/g, "_")}_USERNAME
              </code>{" "}
              and{" "}
              <code className="font-mono">
                {newCred.key.toUpperCase().replace(/\s+/g, "_")}_PASSWORD
              </code>
              .
            </p>
          )}
          {credError && <p className="text-sm text-red-500">{credError}</p>}
          <button
            onClick={addCredential}
            disabled={
              submitting ||
              !newCred.name ||
              !newCred.key ||
              !newCred.value ||
              (credKind === "userpass" && !newCred.username)
            }
            className={primaryButtonClass}
          >
            {submitting ? "Adding..." : "Add Credential"}
          </button>
        </div>
      </section>

      {/* OAuth integrations — handled by the connector framework */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">OAuth Integrations</h2>
          <p className="text-sm text-zinc-500">
            Gmail, Google Calendar, and other OAuth services are installed per-hive
            from the Connectors page — full authorize / refresh-token flow handled
            for you.
          </p>
        </div>
        <a
          href="/setup/connectors"
          className={secondaryButtonClass}
        >
          Open Connectors →
        </a>
      </section>

      {/* Agent CLI Logins (Claude Code, Codex) */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Agent CLI Logins</h2>
          <p className="text-sm text-zinc-500">
            Claude Code and Codex authenticate via their own OAuth flows that
            require an interactive terminal. HiveWright spawns these CLIs and
            inherits whichever login is active on the host machine, so you
            log in once on this server and every agent run picks it up.
          </p>
        </div>

        <div className={`${panelClass} space-y-4`}>
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Claude Code</h3>
            <p className="text-xs text-zinc-500">
              Run on the HiveWright host. The token is stored in <code className="font-mono">~/.claude/</code>.
            </p>
            <pre className="overflow-x-auto rounded-md border border-amber-200/55 bg-amber-100/55 px-3 py-2 text-xs font-mono text-zinc-800 dark:border-white/[0.08] dark:bg-zinc-950/45 dark:text-zinc-200">claude /login</pre>
            <p className="text-xs text-zinc-500">
              Verify with <code className="font-mono">claude /status</code>. If a session expires,
              re-run <code className="font-mono">claude /login</code> on the host — agents will pick up
              the new token on their next spawn.
            </p>
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-medium">Codex</h3>
            <p className="text-xs text-zinc-500">
              Run on the HiveWright host. The token is stored in <code className="font-mono">~/.codex/</code>.
            </p>
            <pre className="overflow-x-auto rounded-md border border-amber-200/55 bg-amber-100/55 px-3 py-2 text-xs font-mono text-zinc-800 dark:border-white/[0.08] dark:bg-zinc-950/45 dark:text-zinc-200">codex login</pre>
            <p className="text-xs text-zinc-500">
              Verify with <code className="font-mono">codex login status</code>. Re-run on expiry.
            </p>
          </div>

          <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-400/[0.06] dark:text-amber-200 dark:ring-1 dark:ring-inset dark:ring-amber-400/15">
            These CLIs prompt in a browser and need a TTY — they can&apos;t be set
            up from the dashboard. If you only have SSH access to the host,
            run <code className="font-mono">ssh -L</code> port-forwarding so the
            login URL opens locally.
          </div>
        </div>
      </section>

      {/* Notification Channels */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Notification Channels</h2>
          <p className="text-sm text-zinc-500">
            Configure how you receive notifications for each hive.
          </p>
        </div>

        {!selectedHive ? (
          <p className="text-sm text-zinc-400">Select a hive to manage notifications.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-zinc-500">
              Managing notifications for <span className="font-medium text-zinc-900 dark:text-zinc-100">{selectedHive.name}</span>
            </p>

            {/* Existing preferences table */}
            <div className={tableWrapClass}>
              <table className="min-w-[560px] w-full text-sm">
                <thead className={tableHeadClass}>
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Channel</th>
                    <th className="px-4 py-3 text-left font-medium">Priority Filter</th>
                    <th className="px-4 py-3 text-left font-medium">Enabled</th>
                    <th className="px-4 py-3 text-left font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {loadingNotifs && (
                    <tr>
                      <td colSpan={4} className="px-4 py-4 text-center text-zinc-400">
                        Loading...
                      </td>
                    </tr>
                  )}
                  {!loadingNotifs && notifPrefs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-4 text-center text-zinc-400">
                        No notification channels configured
                      </td>
                    </tr>
                  )}
                  {notifPrefs.map((pref) => (
                    <tr key={pref.id} className={rowClass}>
                      <td className="px-4 py-3 capitalize">{pref.channel}</td>
                      <td className="px-4 py-3 text-xs text-zinc-500">{pref.priorityFilter}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          pref.enabled
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                            : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                        }`}>
                          {pref.enabled ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => deleteNotifPref(pref.id)}
                          className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add new preference form */}
            <div className={`${panelClass} space-y-3`}>
              <h3 className="text-sm font-medium">Add Channel</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="block text-xs text-zinc-500">Channel</label>
                  <select
                    value={notifForm.channel}
                    onChange={(e) => setNotifForm({ ...notifForm, channel: e.target.value as NewNotifForm["channel"] })}
                    className={inputClass}
                  >
                    <option value="discord">Discord</option>
                    <option value="telegram">Telegram</option>
                    <option value="email">Email</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-zinc-500">Priority Filter</label>
                  <select
                    value={notifForm.priorityFilter}
                    onChange={(e) => setNotifForm({ ...notifForm, priorityFilter: e.target.value as NewNotifForm["priorityFilter"] })}
                    className={inputClass}
                  >
                    <option value="all">All</option>
                    <option value="urgent">Urgent only</option>
                  </select>
                </div>
              </div>

              {/* Dynamic config fields */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {notifForm.channel === "discord" && (
                  <input
                    placeholder="Webhook URL"
                    value={notifForm.webhookUrl}
                    onChange={(e) => setNotifForm({ ...notifForm, webhookUrl: e.target.value })}
                    className={`sm:col-span-2 ${inputClass}`}
                  />
                )}
                {notifForm.channel === "telegram" && (
                  <>
                    <input
                      placeholder="Bot Token"
                      value={notifForm.botToken}
                      onChange={(e) => setNotifForm({ ...notifForm, botToken: e.target.value })}
                      className={inputClass}
                    />
                    <input
                      placeholder="Chat ID"
                      value={notifForm.chatId}
                      onChange={(e) => setNotifForm({ ...notifForm, chatId: e.target.value })}
                      className={inputClass}
                    />
                  </>
                )}
                {notifForm.channel === "email" && (
                  <input
                    placeholder="Email address"
                    type="email"
                    value={notifForm.email}
                    onChange={(e) => setNotifForm({ ...notifForm, email: e.target.value })}
                    className={`sm:col-span-2 ${inputClass}`}
                  />
                )}
              </div>

              {notifError && <p className="text-sm text-red-500">{notifError}</p>}
              {notifSuccess && <p className="text-sm text-green-600">{notifSuccess}</p>}
              <button
                onClick={addNotifPref}
                disabled={addingNotif}
                className={primaryButtonClass}
              >
                {addingNotif ? "Adding..." : "Add Channel"}
              </button>
            </div>

            {/* Send test */}
            <div className="flex items-center gap-3">
              <button
                onClick={sendTestNotif}
                disabled={testingNotif}
                className={secondaryButtonClass}
              >
                {testingNotif ? "Sending..." : "Send Test"}
              </button>
              {testResult && <p className="text-sm text-zinc-500">{testResult}</p>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
