// Barrel for the Supabase-backed data-access layer. These async functions mirror the
// synchronous exports of lib/seed.ts (getScope <-> scope, getMetrics <-> metrics,
// getActions <-> actions, getImpactByMetric <-> impactByMetric, getAggregatedImpact
// <-> aggregatedImpact) so a Server Component can swap the seed import for these
// without reshaping data. SERVER-ONLY: everything here transitively imports
// lib/supabase-server.ts — never import from a Client Component.

export { getScope } from "@/lib/data/scope";
export { getMetrics, getMetricRecords, type MetricRecord } from "@/lib/data/metrics";
export { getActions } from "@/lib/data/actions";
export { getImpactByMetric, getAggregatedImpact } from "@/lib/data/impact";
export { DEMO_SCOPE_ID } from "@/lib/data/config";
