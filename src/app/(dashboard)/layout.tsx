import { HiveProvider } from "@/components/hive-context";
import { DashboardShell } from "@/components/dashboard-shell";
import { LiveUpdatesGate } from "@/components/live-updates-gate";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <HiveProvider>
      <LiveUpdatesGate>
        <DashboardShell>{children}</DashboardShell>
      </LiveUpdatesGate>
    </HiveProvider>
  );
}
