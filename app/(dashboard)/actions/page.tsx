import { Suspense } from "react";
import { loadDashboardData } from "@/lib/data/dashboard";
import { ActionsPageClient } from "@/components/actions/ActionsPageClient";

// Server page: reads decisions + actions + metrics from lib/data (Supabase,
// seed fallback) and hands them to the client child, which owns the
// click-to-select interactivity. Suspense boundary: the client child reads
// ?selected via useSearchParams, which requires one for static prerender.
//
// force-dynamic: this tab WRITES (capture, revisions, resolve-now), so it must
// re-read per request rather than serve a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function ActionsPage() {
  const { actions, decisions, metrics, objective, activeDecisionReport } = await loadDashboardData();
  return (
    <Suspense>
      <ActionsPageClient
        actions={actions}
        decisions={decisions}
        metrics={metrics}
        objective={objective}
        connectorMetricId={activeDecisionReport?.metricId ?? null}
      />
    </Suspense>
  );
}
