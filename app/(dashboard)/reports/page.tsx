import { loadDashboardData } from "@/lib/data/dashboard";
import { ReportsPageClient } from "@/components/reports/ReportsPageClient";

// Server page: reads the full dashboard payload (Supabase, seed fallback) and hands
// the saved reports + the project rollup data to the client, which owns the
// click-to-select interactivity and renders the report document.

export default async function ReportsPage() {
  const {
    reports,
    scope,
    objective,
    aggregatedImpact,
    impactByMetric,
    metrics,
    actions,
  } = await loadDashboardData();

  return (
    <ReportsPageClient
      reports={reports}
      scope={scope}
      objective={objective}
      aggregatedImpact={aggregatedImpact}
      impactByMetric={impactByMetric}
      metrics={metrics}
      actions={actions}
    />
  );
}
