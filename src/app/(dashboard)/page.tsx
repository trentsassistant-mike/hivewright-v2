"use client";

import { useHiveContext } from "@/components/hive-context";
import { ActiveAgentGrid } from "@/components/active-agent-grid";
import { ActiveSupervisorsPanel } from "@/components/active-supervisors-panel";
import { HiveCreationPauseButton } from "@/components/hive-creation-pause-button";
import { OperationsMap } from "@/components/operations-map";
import { OwnerBrief } from "@/components/owner-brief";
import { SupervisorFindingsPanel } from "@/components/supervisor-findings-panel";

export default function DashboardPage() {
  const { selected, loading } = useHiveContext();

  if (loading) return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (!selected) {
    return (
      <div className="rounded-[12px] border border-dashed border-honey-700/40 bg-card/60 p-8 text-center text-[13px] text-muted-foreground">
        No hive selected. Create one in the hive switcher.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="hive-honey-glow flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
            Hive
          </p>
          <h1 className="mt-1 text-[28px] leading-[34px] font-semibold tracking-[-0.01em] text-foreground">
            {selected.name}
          </h1>
          <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
            Owner brief · refreshed every 30s
          </p>
        </div>
        <HiveCreationPauseButton hiveId={selected.id} />
      </div>
      <OperationsMap hiveId={selected.id} hiveName={selected.name} />
      <section>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
          Goal supervisors
        </p>
        <h2 className="mb-3 text-[15px] leading-[22px] font-semibold text-foreground">
          Persistent sessions per goal
        </h2>
        <ActiveSupervisorsPanel hiveId={selected.id} />
      </section>
      <section>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
          Live agents
        </p>
        <h2 className="mb-3 text-[15px] leading-[22px] font-semibold text-foreground">
          Currently executing tasks
        </h2>
        <ActiveAgentGrid hiveId={selected.id} />
      </section>
      <OwnerBrief hiveId={selected.id} />
      <section>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
          Supervisor findings
        </p>
        <h2 className="mb-3 text-[15px] leading-[22px] font-semibold text-foreground">
          What supervisors learned this sprint
        </h2>
        <SupervisorFindingsPanel hiveId={selected.id} />
      </section>
    </div>
  );
}
