"use client";

import { useParams } from "next/navigation";
import { HiveSectionNav } from "@/components/hive-section-nav";
import { InitiativeRunsPanel } from "@/components/initiative-runs-panel";

export default function HiveInitiativesPage() {
  const params = useParams<{ id: string }>();
  const hiveId = params.id;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="hive-honey-glow space-y-3">
        <div className="space-y-2">
          <p className="text-sm uppercase tracking-[0.18em] text-amber-700/70 dark:text-amber-300/60">
            Hive observability
          </p>
          <h1 className="text-2xl font-semibold text-amber-950 dark:text-amber-50">Initiatives</h1>
          <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            Review recent initiative runs, what they evaluated, and why work was created or held back.
          </p>
          <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            The initiative engine proposes candidates. The normal classifier decides the resulting work type and
            routing.
          </p>
        </div>
        <HiveSectionNav hiveId={hiveId} />
      </div>

      <InitiativeRunsPanel hiveId={hiveId} />
    </div>
  );
}
