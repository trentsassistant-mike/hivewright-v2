"use client";
import { useHiveContext } from "./hive-context";

function ChevronIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-honey-300/70"
    >
      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HiveSwitcher() {
  const { hives, selected, selectHive, loading } = useHiveContext();

  if (loading) {
    return <div className="px-3 py-2 text-[13px] text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="relative">
      <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-honey-300/70">
        Hive
      </p>
      <select
        value={selected?.id || ""}
        onChange={(e) => selectHive(e.target.value)}
        className="w-full appearance-none rounded-[10px] border border-white/[0.06] bg-[#0F1114] px-3 py-2 pr-8 text-[13px] font-medium text-foreground focus:border-honey-500/45 focus:outline-none focus:ring-2 focus:ring-honey-500/30"
      >
        {hives.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
        {hives.length === 0 && <option value="">No hives</option>}
      </select>
      <ChevronIcon />
    </div>
  );
}
