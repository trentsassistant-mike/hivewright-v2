import Link from "next/link";

const setupLinks = [
  {
    href: "/setup/models",
    title: "Models",
    description: "Available models, hive credentials, health, quality, cost, and routing.",
  },
  {
    href: "/setup/adapters",
    title: "Adapters",
    description: "Runtime adapter configuration for Codex, Claude Code, Gemini, OpenClaw, and Ollama.",
  },
  {
    href: "/setup/embeddings",
    title: "Embeddings",
    description: "Memory embedding provider, model, credential, and endpoint setup.",
  },
  {
    href: "/setup/work-intake",
    title: "Work Intake",
    description: "Classifier provider, model, fallback, and tuning for incoming work.",
  },
  {
    href: "/setup/connectors",
    title: "Connectors",
    description: "Hive-scoped integrations and connector credentials.",
  },
  {
    href: "/setup/health",
    title: "Setup Health",
    description: "Readiness checks across hives, runtime, models, memory, and connectors.",
  },
  {
    href: "/setup/updates",
    title: "Updates",
    description: "Version, Git remote status, terminal update command, and owner-triggered HiveWright updates.",
  },
];

export default function SetupPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Setup</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Foundational HiveWright configuration and hive setup checks.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {setupLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
          >
            <h2 className="text-sm font-semibold">{link.title}</h2>
            <p className="mt-2 text-xs leading-5 text-zinc-500">{link.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
