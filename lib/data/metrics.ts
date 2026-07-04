// getMetrics() — the daily metric series + display config, mapped from Supabase to
// lib/types.ts Metric. Mirrors the lib/seed.ts `metrics` export.

import { cache } from "react";
import type { Metric, Observation } from "@/lib/types";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  DEMO_SCOPE_ID,
  METRIC_CONFIG_BY_NAME,
  METRIC_ORDER,
  formatFromUnit,
  sourceLabel,
} from "@/lib/data/config";

type MetricRow = {
  metric_id: string;
  name: string;
  unit: string | null;
  source: string;
  granularity: string;
};
type ObsRow = { metric_id: string; obs_date: string; value: number | string | null };

/**
 * A UI Metric paired with its DB metric_id (UUID). The UI Metric.id is the stable
 * slug; the graph (nodes/edges) keys by metric_id, so callers that join readouts
 * (actions, impact) need both.
 */
export type MetricRecord = { metricId: string; metric: Metric };

/**
 * All metrics in the demo scope (UI Metric + DB metric_id), ordered to match the UI's
 * canonical metric order (lib/seed.ts). A metric whose name has no UI config is
 * skipped (we never guess a color / inversion for an unknown metric).
 */
export const getMetricRecords = cache(async function getMetricRecords(): Promise<
  MetricRecord[]
> {
  const sb = getServerSupabase();

  const metricsRes = await sb
    .from("metrics")
    .select("metric_id, name, unit, source, granularity")
    .eq("scope_id", DEMO_SCOPE_ID);
  if (metricsRes.error) throw metricsRes.error;
  const metricRows = (metricsRes.data ?? []) as MetricRow[];
  if (metricRows.length === 0) return [];

  // Fetch observations PER METRIC: a single .in() query would blow past PostgREST's
  // default 1000-row page cap (5 metrics x 210 days = 1050), silently truncating the
  // series. Per metric each series is < 1000 rows, so no page is ever clipped.
  const obsResults = await Promise.all(
    metricRows.map((m) =>
      sb
        .from("metric_observations")
        .select("metric_id, obs_date, value")
        .eq("metric_id", m.metric_id)
        .order("obs_date", { ascending: true }),
    ),
  );

  const seriesByMetric = new Map<string, Observation[]>();
  const lastDateByMetric = new Map<string, string>();
  for (const res of obsResults) {
    if (res.error) throw res.error;
    for (const o of (res.data ?? []) as ObsRow[]) {
      if (o.value == null) continue; // NULL day: no observation to plot
      const list = seriesByMetric.get(o.metric_id) ?? [];
      list.push({ date: o.obs_date, value: Number(o.value) });
      seriesByMetric.set(o.metric_id, list);
      lastDateByMetric.set(o.metric_id, o.obs_date);
    }
  }

  const records: MetricRecord[] = [];
  for (const row of metricRows) {
    const cfg = METRIC_CONFIG_BY_NAME[row.name];
    if (!cfg) continue; // unknown metric — never fabricate display config
    const series = seriesByMetric.get(row.metric_id) ?? [];
    const lastDate = lastDateByMetric.get(row.metric_id);
    records.push({
      metricId: row.metric_id,
      metric: {
        id: cfg.id,
        name: row.name,
        color: cfg.color,
        format: formatFromUnit(row.unit),
        source: sourceLabel(row.source),
        cadence: "Daily",
        // Honest last-ingest proxy: the latest observation date (no separate ingest
        // timestamp is stored). Midnight UTC of that day.
        lastUpdated: lastDate ? `${lastDate}T00:00:00Z` : new Date(0).toISOString(),
        rows: series.length,
        higherIsBetter: cfg.higherIsBetter,
        series,
      },
    });
  }

  records.sort(
    (a, b) => METRIC_ORDER.indexOf(a.metric.id) - METRIC_ORDER.indexOf(b.metric.id),
  );
  return records;
});

/**
 * All metrics in the demo scope with their full daily series, ordered to match the
 * UI's canonical metric order. Mirrors the lib/seed.ts `metrics` export.
 */
export async function getMetrics(): Promise<Metric[]> {
  return (await getMetricRecords()).map((r) => r.metric);
}
