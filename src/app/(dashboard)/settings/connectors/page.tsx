"use client";

import { useEffect, useMemo, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

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

interface Install {
  id: string;
  hiveId: string;
  connectorSlug: string;
  displayName: string;
  config: Record<string, unknown>;
  credentialId: string | null;
  status: string;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  successes7d: number;
  errors7d: number;
}

export default function ConnectorsPage() {
  const { selected } = useHiveContext();
  const [catalog, setCatalog] = useState<Connector[]>([]);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ slug: string; text: string; kind: "ok" | "err" } | null>(null);
  const [oauthBanner, setOauthBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    // Pick up oauth round-trip query params so the dashboard shows a banner
    // after Google/etc. redirects the user back here.
    const search = new URLSearchParams(window.location.search);
    if (search.get("oauth_installed") === "1") {
      setOauthBanner({ kind: "ok", text: "Connector installed via OAuth." });
    } else if (search.get("oauth_error")) {
      setOauthBanner({ kind: "err", text: `OAuth failed: ${search.get("oauth_error")}` });
    }
  }, []);

  useEffect(() => {
    fetch("/api/connectors")
      .then((r) => r.json())
      .then((b) => setCatalog(b.data ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    const load = () =>
      fetch(`/api/connector-installs?hiveId=${selected.id}`)
        .then((r) => r.json())
        .then((b) => setInstalls(b.data ?? []))
        .catch(() => {});
    load();
  }, [selected]);

  const byCategory = useMemo(() => {
    const m: Record<string, Connector[]> = {};
    for (const c of catalog) (m[c.category] ||= []).push(c);
    return m;
  }, [catalog]);

  function openInstaller(slug: string) {
    setExpanded(slug);
    setForm({});
    setDisplayName("");
    setFlash(null);
  }

  async function submitInstall(c: Connector) {
    if (!selected) return;
    setBusy(c.slug);
    try {
      const res = await fetch("/api/connector-installs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId: selected.id,
          connectorSlug: c.slug,
          displayName: displayName || c.name,
          fields: form,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "install failed");

      // Refresh the install list so we can find the row we just created.
      const refreshed = await fetch(`/api/connector-installs?hiveId=${selected.id}`).then((r) => r.json());
      const newInstalls: Install[] = refreshed.data ?? [];
      setInstalls(newInstalls);

      // If the connector has a test operation, auto-run it now so the
      // owner doesn't have to scroll up to the Installed list and hunt
      // for the Test button. Same fetch call as testInstall() but inline
      // so we can report the combined install+test flash in one place.
      const justInstalled = newInstalls.find(
        (i) => i.connectorSlug === c.slug && i.displayName === (displayName || c.name),
      );
      if (c.operations.length > 0 && justInstalled) {
        setFlash({ slug: c.slug, text: "Installed. Running Test connection…", kind: "ok" });
        try {
          const testRes = await fetch(`/api/connector-installs/${justInstalled.id}/test`, {
            method: "POST",
          });
          const testBody = await testRes.json();
          const r = testBody.data ?? {};
          if (r.success) {
            setFlash({
              slug: c.slug,
              text: `Installed and test passed (${r.durationMs}ms).${c.requiresDispatcherRestart ? " Use Activate to bring it online." : ""}`,
              kind: "ok",
            });
          } else {
            setFlash({
              slug: c.slug,
              text: `Installed, but test failed: ${r.error ?? "unknown"}. Fix the credentials and retest from the Installed list.`,
              kind: "err",
            });
          }
          // Refresh again so last_tested_at / last_error reflect the auto-test.
          const reRefreshed = await fetch(`/api/connector-installs?hiveId=${selected.id}`).then((r) => r.json());
          setInstalls(reRefreshed.data ?? []);
        } catch (testErr) {
          setFlash({
            slug: c.slug,
            text: `Installed, but auto-test errored: ${(testErr as Error).message}`,
            kind: "err",
          });
        }
      } else {
        setFlash({ slug: c.slug, text: "Installed.", kind: "ok" });
      }
      setExpanded(null);
    } catch (e) {
      setFlash({ slug: c.slug, text: (e as Error).message, kind: "err" });
    } finally {
      setBusy(null);
    }
  }

  async function activateInstall(install: Install) {
    if (!window.confirm(
      `Restart the dispatcher to bring ${install.displayName} online? In-flight tasks will be interrupted and resumed after boot.`,
    )) {
      return;
    }
    setBusy(install.id);
    try {
      const res = await fetch("/api/dispatcher/restart", { method: "POST" });
      const body = await res.json();
      if (!res.ok || body?.error) {
        setFlash({ slug: install.id, text: body?.error ?? "restart failed", kind: "err" });
        return;
      }
      setFlash({ slug: install.id, text: "Dispatcher restarted. Connector is now live.", kind: "ok" });
    } catch (e) {
      setFlash({ slug: install.id, text: (e as Error).message, kind: "err" });
    } finally {
      setBusy(null);
    }
  }

  async function testInstall(install: Install) {
    setBusy(install.id);
    setFlash(null);
    try {
      const res = await fetch(`/api/connector-installs/${install.id}/test`, { method: "POST" });
      const body = await res.json();
      const r = body.data ?? {};
      const msg = r.success
        ? `Sent in ${r.durationMs}ms.`
        : `Failed: ${r.error ?? "unknown"}`;
      setFlash({ slug: install.id, text: msg, kind: r.success ? "ok" : "err" });
      // Refresh install list (so last_tested_at / last_error update).
      if (selected) {
        const refreshed = await fetch(`/api/connector-installs?hiveId=${selected.id}`).then((r) => r.json());
        setInstalls(refreshed.data ?? []);
      }
    } catch (e) {
      setFlash({ slug: install.id, text: (e as Error).message, kind: "err" });
    } finally {
      setBusy(null);
    }
  }

  async function removeInstall(install: Install) {
    if (!window.confirm(`Remove ${install.displayName}? Existing agent calls using it will start failing.`)) {
      return;
    }
    setBusy(install.id);
    try {
      await fetch(`/api/connector-installs/${install.id}`, { method: "DELETE" });
      if (selected) {
        const refreshed = await fetch(`/api/connector-installs?hiveId=${selected.id}`).then((r) => r.json());
        setInstalls(refreshed.data ?? []);
      }
    } finally {
      setBusy(null);
    }
  }

  async function toggleInstallStatus(install: Install) {
    const targetStatus = install.status === "active" ? "disabled" : "active";
    const action = targetStatus === "disabled" ? "Disable" : "Enable";
    if (!window.confirm(`${action} ${install.displayName}? ${targetStatus === "disabled" ? "Agents will not be able to use this connector until re-enabled." : "This connector will become available to agents again."}`)) {
      return;
    }
    setBusy(install.id);
    setFlash(null);
    try {
      const res = await fetch(`/api/connector-installs/${install.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: targetStatus }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFlash({ slug: install.id, text: (body as { error?: string }).error ?? `HTTP ${res.status}`, kind: "err" });
        return;
      }
      setFlash({ slug: install.id, text: `${action}d successfully.`, kind: "ok" });
      if (selected) {
        const refreshed = await fetch(`/api/connector-installs?hiveId=${selected.id}`).then((r) => r.json());
        setInstalls(refreshed.data ?? []);
      }
    } catch (e) {
      setFlash({ slug: install.id, text: (e as Error).message, kind: "err" });
    } finally {
      setBusy(null);
    }
  }

  if (!selected) return <p className="text-amber-400/60">Select a hive first.</p>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-amber-50">Connectors</h1>
        <p className="text-sm text-amber-600/70">
          Wire {selected.name} up to the outside world. Each connector uses encrypted
          credentials and is scoped to this hive only.
        </p>
        {oauthBanner && (
          <p
            className={`mt-2 rounded-md px-3 py-2 text-sm ${
              oauthBanner.kind === "ok"
                ? "bg-emerald-950/40 text-emerald-200"
                : "bg-rose-950/40 text-rose-200"
            }`}
          >
            {oauthBanner.text}
          </p>
        )}
      </div>

      <section>
        <h2 className="mb-3 text-lg font-medium text-amber-100">Installed</h2>
        {installs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-amber-500/60">
            No connectors installed for this hive yet. Pick one below to get started.
          </p>
        ) : (
          <div className="space-y-2">
            {installs.map((i) => {
              const def = catalog.find((c) => c.slug === i.connectorSlug);
              return (
                <div
                  key={i.id}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-2xl">{def?.icon ?? "🔌"}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium text-amber-50">{i.displayName}</p>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                              i.status === "active"
                                ? "bg-emerald-900/40 text-emerald-300 ring-emerald-600/30"
                                : "bg-zinc-800/60 text-zinc-400 ring-zinc-600/30"
                            }`}
                          >
                            {i.status}
                          </span>
                        </div>
                        <p className="truncate text-xs text-amber-400/70">
                          {def?.name ?? i.connectorSlug}
                          {i.lastTestedAt && ` · last tested ${new Date(i.lastTestedAt).toLocaleString()}`}
                        </p>
                        <p className="text-xs text-amber-500/60">
                          {i.successes7d} ok / {i.errors7d} err (7d)
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => testInstall(i)}
                        disabled={busy === i.id}
                        className="rounded bg-amber-500/15 px-3 py-1 text-xs text-amber-100 ring-1 ring-inset ring-amber-500/25 hover:bg-amber-500/25 disabled:opacity-50"
                      >
                        {busy === i.id ? "Testing…" : "Test"}
                      </button>
                      {def?.requiresDispatcherRestart && (
                        <button
                          onClick={() => activateInstall(i)}
                          disabled={busy === i.id}
                          title="Restarts the dispatcher so this connector starts listening / processing."
                          className="rounded bg-emerald-600/20 px-3 py-1 text-xs text-emerald-100 ring-1 ring-inset ring-emerald-500/30 hover:bg-emerald-600/30 disabled:opacity-50"
                        >
                          {busy === i.id ? "Restarting…" : "Activate"}
                        </button>
                      )}
                      <button
                        onClick={() => toggleInstallStatus(i)}
                        disabled={busy === i.id}
                        aria-label={i.status === "active" ? `Disable ${i.displayName}` : `Enable ${i.displayName}`}
                        className={`rounded border px-3 py-1 text-xs disabled:opacity-50 ${
                          i.status === "active"
                            ? "border-zinc-600/50 text-zinc-400 hover:border-zinc-400/70 hover:text-zinc-200"
                            : "border-emerald-700/50 text-emerald-400 hover:bg-emerald-950/30 hover:text-emerald-300"
                        }`}
                      >
                        {busy === i.id ? "…" : i.status === "active" ? "Disable" : "Enable"}
                      </button>
                      <button
                        onClick={() => removeInstall(i)}
                        disabled={busy === i.id}
                        className="rounded border border-rose-900/50 px-3 py-1 text-xs text-rose-300 hover:bg-rose-950/40 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {i.lastError && (
                    <p className="mt-2 rounded bg-rose-950/40 p-2 text-xs text-rose-300">
                      Last error: {i.lastError}
                    </p>
                  )}
                  {flash && flash.slug === i.id && (
                    <p className={`mt-2 text-xs ${flash.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}>
                      {flash.text}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium text-amber-100">Catalog</h2>
        {Object.entries(byCategory).map(([cat, cs]) => (
          <div key={cat} className="mb-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-amber-500/60">{cat}</p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {cs.map((c) => {
                const open = expanded === c.slug;
                return (
                  <div
                    key={c.slug}
                    className={`rounded-lg border p-3 transition ${
                      open
                        ? "border-amber-500/50 bg-amber-400/[0.06]"
                        : "border-border bg-card/60 hover:border-amber-500/30"
                    }`}
                  >
                    {c.authType === "oauth2" ? (
                      <a
                        href={`/api/oauth/${c.slug}/start?hiveId=${selected.id}&displayName=${encodeURIComponent(c.name)}`}
                        className="flex w-full items-start gap-3 text-left"
                      >
                        <span className="text-2xl">{c.icon ?? "🔌"}</span>
                        <div className="flex-1">
                          <p className="font-medium text-amber-50">{c.name}</p>
                          <p className="text-xs text-amber-400/70">{c.description}</p>
                          <p className="mt-1 text-xs text-amber-500/80">
                            Click to connect with {c.name} (OAuth)
                          </p>
                        </div>
                      </a>
                    ) : (
                      <button
                        onClick={() => (open ? setExpanded(null) : openInstaller(c.slug))}
                        className="flex w-full items-start gap-3 text-left"
                      >
                        <span className="text-2xl">{c.icon ?? "🔌"}</span>
                        <div className="flex-1">
                          <p className="font-medium text-amber-50">{c.name}</p>
                          <p className="text-xs text-amber-400/70">{c.description}</p>
                        </div>
                      </button>
                    )}
                    {open && c.authType !== "oauth2" && (
                      <div className="mt-3 space-y-2 border-t border-border pt-3">
                        <div>
                          <label className="text-xs text-amber-400/80">Display name</label>
                          <input
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder={c.name}
                            className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-amber-50"
                          />
                        </div>
                        {c.setupFields.map((f) => (
                          <div key={f.key}>
                            <label className="text-xs text-amber-400/80">
                              {f.label}
                              {f.required && <span className="text-rose-400"> *</span>}
                            </label>
                            {f.type === "textarea" ? (
                              <textarea
                                value={form[f.key] ?? ""}
                                onChange={(e) =>
                                  setForm((s) => ({ ...s, [f.key]: e.target.value }))
                                }
                                placeholder={f.placeholder}
                                rows={2}
                                className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-amber-50"
                              />
                            ) : (
                              <input
                                type={f.type === "password" ? "password" : "text"}
                                value={form[f.key] ?? ""}
                                onChange={(e) =>
                                  setForm((s) => ({ ...s, [f.key]: e.target.value }))
                                }
                                placeholder={f.placeholder}
                                className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-amber-50"
                              />
                            )}
                            {f.helpText && (
                              <p className="text-xs text-amber-500/60">{f.helpText}</p>
                            )}
                          </div>
                        ))}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => submitInstall(c)}
                            disabled={busy === c.slug}
                            className="rounded bg-amber-600 px-3 py-1 text-sm text-amber-950 hover:bg-amber-500 disabled:opacity-50"
                          >
                            {busy === c.slug
                              ? "Saving…"
                              : c.operations.length > 0
                                ? "Save & test"
                                : "Save"}
                          </button>
                          <button
                            onClick={() => setExpanded(null)}
                            className="text-xs text-amber-400/70 hover:text-amber-200"
                          >
                            Cancel
                          </button>
                          {c.operations.length > 0 && (
                            <span className="text-xs text-amber-500/60">
                              Saves your credentials (encrypted) and runs the test automatically.
                              {c.requiresDispatcherRestart && " Use Activate afterward to bring it online."}
                            </span>
                          )}
                        </div>
                        {flash && flash.slug === c.slug && (
                          <p className={`text-xs ${flash.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}>
                            {flash.text}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
