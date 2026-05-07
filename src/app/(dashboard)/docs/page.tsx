"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Connector {
  slug: string;
  name: string;
  category: string;
  description: string;
  icon: string | null;
  authType: string;
  operations: { slug: string; label: string }[];
}

interface Role {
  slug: string;
  name: string;
  department: string | null;
  type: string;
  recommendedModel: string | null;
  adapterType: string;
  // `skills` comes back as the raw JSONB column — can be null, an array, or
  // occasionally a string when legacy rows weren't normalised. Normalise
  // defensively on render.
  skills: unknown;
}

function normaliseSkills(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return raw.trim() ? [raw] : [];
    }
  }
  return [];
}

export default function DocsPage() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);

  useEffect(() => {
    fetch("/api/connectors")
      .then((r) => r.json())
      .then((b) => setConnectors(b.data ?? []))
      .catch(() => {});
    fetch("/api/roles")
      .then((r) => r.json())
      .then((b) => setRoles(b.data ?? []))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">HiveWright docs</h1>
        <p className="mt-1 text-sm text-amber-700/80 dark:text-amber-400/70">
          Live catalogue of roles, skills and connectors for this install.
          Everything below is generated from the running system, so it never
          drifts from the code.
        </p>
      </header>

      <section>
        <h2 className="mb-2 text-xl font-medium">Quick start</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/80">
          <li>Sign in (or create the first owner on this install).</li>
          <li>
            Create a hive from{" "}
            <Link href="/hives/new" className="underline decoration-amber-500/60 hover:text-amber-700 dark:hover:text-amber-300">
              Hives → New hive
            </Link>
            .
          </li>
          <li>
            Install at least one outbound connector (Discord, Slack or SMTP) so
            you get owner pings.
          </li>
          <li>Describe the first goal — the system classifies and delegates it.</li>
          <li>
            Let the daily world-scan + weekly improvement sweep run; review Tier
            2 decisions at the end of the week.
          </li>
        </ol>
      </section>

      <section>
        <h2 className="mb-2 text-xl font-medium">Built-in connectors</h2>
        <p className="text-sm text-amber-700/80 dark:text-amber-400/70">
          Each connector is scoped per hive, stores credentials encrypted at rest,
          and logs every invocation to <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/40">connector_events</code>.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {connectors.map((c) => (
            <div
              key={c.slug}
              className="rounded-lg border border-amber-200/60 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20"
            >
              <p className="font-medium">
                {c.icon ?? "🔌"} {c.name}{" "}
                <span className="text-xs text-amber-600/80 dark:text-amber-500/70">· {c.authType}</span>
              </p>
              <p className="mt-1 text-xs text-foreground/70">{c.description}</p>
              {c.operations.length > 0 && (
                <p className="mt-1 text-xs text-amber-600/70 dark:text-amber-500/60">
                  Operations: {c.operations.map((o) => o.slug).join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xl font-medium">Role library</h2>
        <p className="text-sm text-amber-700/80 dark:text-amber-400/70">
          Roles are the atomic workers. Goal supervisors route tasks to them; the
          dispatcher spawns ephemeral sessions. Configure per-role model + adapter
          on{" "}
          <Link href="/roles" className="underline decoration-amber-500/60 hover:text-amber-700 dark:hover:text-amber-300">
            Roles &amp; Agents
          </Link>
          .
        </p>
        <table className="mt-3 w-full text-xs">
          <thead className="text-left text-amber-700/80 dark:text-amber-400/80">
            <tr>
              <th className="py-1 pr-3">Role</th>
              <th className="py-1 pr-3">Department</th>
              <th className="py-1 pr-3">Adapter</th>
              <th className="py-1 pr-3">Model</th>
              <th className="py-1">Skills</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => {
              const skills = normaliseSkills(r.skills);
              return (
                <tr key={r.slug} className="border-t border-amber-200/60 dark:border-amber-900/40">
                  <td className="py-1 pr-3 font-medium">{r.name}</td>
                  <td className="py-1 pr-3 text-foreground/60">{r.department ?? "—"}</td>
                  <td className="py-1 pr-3 text-foreground/60">{r.adapterType}</td>
                  <td className="py-1 pr-3 text-foreground/60">{r.recommendedModel ?? "—"}</td>
                  <td className="py-1 text-amber-600/70 dark:text-amber-400/60">{skills.join(", ") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-2 text-xl font-medium">How the pieces fit</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/80">
          <li>
            <strong>Owner Brief</strong> (dashboard home) = one-glance status: what
            changed, what needs you, what&apos;s stalled.
          </li>
          <li>
            <strong>Goal supervisors</strong> = persistent sessions that own
            strategic decomposition of multi-step work.
          </li>
          <li>
            <strong>Doctor</strong> = self-healing for failed tasks; escalates to a
            Tier-3 decision only when it can&apos;t recover in 2 attempts.
          </li>
          <li>
            <strong>Improvement sweep</strong> = weekly review proposing role
            evolution, reliability, and efficiency Tier-2 decisions.
          </li>
          <li>
            <strong>Connectors</strong> = per-hive bindings to outside services
            (API-key or OAuth). Agents call typed operations; runtime handles
            auth, retry, logging.
          </li>
          <li>
            <strong>AI Board</strong> = Analyst → Strategist → Risk → Accountant →
            Chair deliberative layer above the EA.
          </li>
        </ul>
      </section>
    </div>
  );
}
