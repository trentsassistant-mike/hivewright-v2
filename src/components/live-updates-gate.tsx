"use client";

import { type ReactNode } from "react";
import { useHiveContext } from "@/components/hive-context";
import { LiveUpdatesProvider } from "@/components/live-updates-provider";

export function LiveUpdatesGate({ children }: { children: ReactNode }) {
  const { selected } = useHiveContext();
  if (!selected) return <>{children}</>;
  return <LiveUpdatesProvider hiveId={selected.id}>{children}</LiveUpdatesProvider>;
}
