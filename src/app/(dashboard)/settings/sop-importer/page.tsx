"use client";

import { useState } from "react";
import Link from "next/link";
import { useHiveContext } from "@/components/hive-context";

const EXAMPLE = `# Handle Lakes Bushland refund request

## When to use this skill

When a guest requests a refund on a paid booking and the cancellation falls
inside our published refund policy.

## Steps

1. Look up the booking in NewBook (guest email + last 4 of card).
2. Confirm the cancellation date is outside the no-refund window for
   that rate plan.
3. Issue the refund via Stripe using the original charge id.
4. Email the guest a confirmation of the refund amount and estimated
   landing time (3-5 business days).
5. Record the refund in Xero against the Lakes Bushland revenue account.

## Guardrails

- Any refund over $500 needs owner approval via a Tier 2 decision.
- Do not refund if the guest has an outstanding damage claim open.`;

export default function SopImporterPage() {
  const { selected } = useHiveContext();
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"hive" | "system">("hive");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit() {
    if (!selected) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId: selected.id,
          title,
          scope,
          content,
          sourceRole: "owner",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "import failed");
      setFlash({
        kind: "ok",
        text: `Draft queued as "${body.data.slug}". QA will review it shortly.`,
      });
      setTitle("");
      setContent("");
    } catch (e) {
      setFlash({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!selected)
    return <p className="text-amber-400/60">Select a hive to import an SOP.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-amber-50">Workflow capture</h1>
        <p className="text-sm text-amber-600/70">
          Paste or write an SOP describing how you do something today. The system
          converts it into a reusable skill your agents can apply. Drafts go
          through QA before they land in the live skill library.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/20 bg-amber-950/10 p-4">
        <p className="text-sm text-amber-200/80">
          Prefer to record rather than write?{" "}
          <Link
            href="/setup/workflow-capture"
            className="text-amber-400 underline hover:text-amber-200"
          >
            Use browser capture
          </Link>{" "}
          to record your browser tab and let HiveWright draft the workflow from
          what it observes.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <label className="block text-xs uppercase tracking-wide text-amber-400/80">
            Title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Handle Lakes Bushland refund request"
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-amber-50"
          />
          <p className="mt-1 text-xs text-amber-500/60">
            Becomes the skill title and a URL-friendly slug.
          </p>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-amber-400/80">
            Scope
          </label>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "hive" | "system")}
            className="mt-1 rounded border border-border bg-background px-2 py-1 text-sm text-amber-50"
          >
            <option value="hive">This hive only ({selected.name})</option>
            <option value="system">System-wide (all hives)</option>
          </select>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-amber-400/80">
            Content
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={EXAMPLE}
            rows={18}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-amber-50"
          />
          <p className="mt-1 text-xs text-amber-500/60">
            Markdown is fine. If you paste plain steps, the system wraps them
            into a minimal SKILL.md shape for you. QA can tidy before approval.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={submit}
            disabled={busy || !title || !content}
            className="rounded bg-amber-600 px-3 py-1.5 text-sm text-amber-950 hover:bg-amber-500 disabled:opacity-50"
          >
            {busy ? "Importing…" : "Import SOP"}
          </button>
          <button
            onClick={() => {
              setTitle("");
              setContent(EXAMPLE);
              setScope("hive");
            }}
            className="text-xs text-amber-400/70 hover:text-amber-200"
          >
            Use the example
          </button>
        </div>
        {flash && (
          <p className={flash.kind === "ok" ? "text-sm text-emerald-300" : "text-sm text-rose-300"}>
            {flash.text}
          </p>
        )}
      </div>
    </div>
  );
}
