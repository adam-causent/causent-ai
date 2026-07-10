// getImpactByMetric() + getAggregatedImpact() — the Impact-tab aggregates, mapped
// from the materialized graph. Mirrors lib/seed.ts `impactByMetric` /
// `aggregatedImpact`, but every number is derived from real engine readouts: only
// CONFIDENT (belief 1.0) directional edges contribute, so nothing is fabricated and
// the "gathering data" reality is surfaced honestly (no invented prior-period deltas).

import type { Direction, ImpactStat, MetricImpact } from "@/lib/types";
import { isConfident, isGoodOutcome } from "@/lib/data/config";
import { getMetricRecords, type MetricRecord } from "@/lib/data/metrics";
import { loadEdgeReadouts, type EdgeReadout } from "@/lib/data/graph";
import { formatImpactMagnitude } from "@/lib/data/readout";

/** Direction of a signed net effect, with a small dead-zone at zero. */
function directionOf(value: number): Direction {
  if (value > 0.0001) return "up";
  if (value < -0.0001) return "down";
  return "neutral";
}

/**
 * Net confident ITS lift per metric (metric_id -> summed lift over that metric's
 * CONFIDENT directional action edges). Non-confident / withheld edges contribute 0.
 */
function netConfidentLift(
  records: MetricRecord[],
  edges: Map<string, EdgeReadout>,
): Map<string, number> {
  const net = new Map<string, number>();
  for (const rec of records) net.set(rec.metricId, 0);
  for (const edge of edges.values()) {
    if (!isConfident(edge.dbDirection, edge.beliefScore) || edge.lift == null) continue;
    if (!net.has(edge.metricId)) continue;
    net.set(edge.metricId, (net.get(edge.metricId) ?? 0) + edge.lift);
  }
  return net;
}

/**
 * One diverging-bar row per metric (canonical order): the net CONFIDENT causal
 * impact in that metric's native units. Metrics with no confident edge read a neutral
 * "—" (honest: no confident claim yet), not a fabricated zero-delta.
 */
export async function getImpactByMetric(): Promise<MetricImpact[]> {
  const [records, edges] = await Promise.all([getMetricRecords(), loadEdgeReadouts()]);
  const net = netConfidentLift(records, edges);

  return records.map((rec) => {
    const value = net.get(rec.metricId) ?? 0;
    const direction = directionOf(value);
    return {
      metricId: rec.metric.id,
      value,
      label: direction === "neutral" ? "—" : formatImpactMagnitude(value, rec.metric.format),
      direction,
      good: isGoodOutcome(direction, rec.metric.higherIsBetter),
    };
  });
}

/**
 * The Aggregated-Impact strip stats. The 2026-07-09 strip redesign reads only the
 * improvement-rate figure from here (the metric tiles come from impactByMetric),
 * so this computes exactly that: the share of CONFIDENT readouts whose lift was a
 * good business outcome. No invented "vs prior period" numbers (the engine
 * produces none) — the sublabel states what the figure is measured over.
 */
export async function getAggregatedImpact(): Promise<ImpactStat[]> {
  const [records, edges] = await Promise.all([getMetricRecords(), loadEdgeReadouts()]);

  const higherIsBetterByMetric = new Map(
    records.map((r) => [r.metricId, r.metric.higherIsBetter]),
  );

  let confident = 0;
  let confidentGood = 0;
  for (const edge of edges.values()) {
    if (!isConfident(edge.dbDirection, edge.beliefScore) || edge.lift == null) continue;
    confident += 1;
    const higherIsBetter = higherIsBetterByMetric.get(edge.metricId) ?? true;
    if ((edge.lift > 0) === higherIsBetter) confidentGood += 1;
  }

  const winRate = confident > 0 ? Math.round((confidentGood / confident) * 100) : 0;

  return [
    {
      label: "Improvement Rate",
      value: `${winRate}%`,
      comparison: `${confidentGood} / ${confident} confident readouts`,
      tone: winRate >= 50 ? "positive" : "negative",
    },
  ];
}
