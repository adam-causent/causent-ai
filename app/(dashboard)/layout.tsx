import { Suspense } from "react";
import { GlobalHeader } from "@/components/shell/GlobalHeader";
import { TabStrip } from "@/components/shell/TabStrip";
import { CoreMetricsDrawer } from "@/components/shell/CoreMetricsDrawer";
import { loadDashboardData } from "@/lib/data/dashboard";

// Persistent shell: global header + tab strip on top, the active tab in the
// scrolling middle, and the Core Metrics drawer pinned to the bottom on every tab.
// Data (scope + metrics + actions) is read once here (Supabase, memoized per request)
// and threaded into the shell's client components as props — the seed is never read.

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { scope, metrics, actions, decisions, activeDecisionReport } = await loadDashboardData();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--bg)]">
      <GlobalHeader />
      <TabStrip scope={scope} />
      <main className="scroll-slim min-h-0 flex-1 overflow-y-auto">{children}</main>
      <Suspense fallback={null}>
        <CoreMetricsDrawer
          metrics={metrics}
          actions={actions}
          decisions={decisions}
          projectMetricLabel={activeDecisionReport?.metricProjection.metricName ?? null}
        />
      </Suspense>
    </div>
  );
}
