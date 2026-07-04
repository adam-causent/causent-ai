// getImpactByMetric() + getAggregatedImpact() — the Impact-tab aggregates, mapped
// from the materialized graph. Mirrors lib/seed.ts `impactByMetric` /
// `aggregatedImpact`, but every number is derived from real engine readouts: only
// CONFIDENT (belief 1.0) directional edges contribute, so nothing is fabricated and
// the "gathering data" reality is surfaced honestly (no invented prior-period deltas).

import type { Direction, ImpactStat, MetricImpact } from "@/lib/types";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  DEMO_SCOPE_ID,
  isConfident,
  isGoodOutcome,
} from "@/lib/data/config";
import { formatCurrencyDelta } from "@/lib/format";
import { getMetricRecords, type MetricRecord } from "@/lib/data/metrics";
import { edgeKey, loadEdgeReadouts, type EdgeReadout } from "@/lib/data/graph";
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
 * The Aggregated-Impact strip. Every card is computed from the graph — no invented
 * "vs prior period" numbers (the engine produces none). Sublabels describe what the
 * figure is measured over instead of comparing to a fabricated baseline.
 */
export async function getAggregatedImpact(): Promise<ImpactStat[]> {
  const sb = getServerSupabase();
  const [records, edges, actionsCountRes] = await Promise.all([
    getMetricRecords(),
    loadEdgeReadouts(),
    sb
      .from("actions")
      .select("action_id", { count: "exact", head: true })
      .eq("scope_id", DEMO_SCOPE_ID),
  ]);
  if (actionsCountRes.error) throw actionsCountRes.error;

  const higherIsBetterByMetric = new Map(
    records.map((r) => [r.metricId, r.metric.higherIsBetter]),
  );
  const formatByMetric = new Map(records.map((r) => [r.metricId, r.metric.format]));

  const actionsShipped = actionsCountRes.count ?? 0;
  const evaluatedEdges = edges.size;

  let confident = 0;
  let confidentGood = 0;
  let netCurrency = 0;
  let insufficient = 0;

  for (const edge of edges.values()) {
    if (edge.beliefReason === "INSUFFICIENT_HISTORY") insufficient += 1;
    if (!isConfident(edge.dbDirection, edge.beliefScore) || edge.lift == null) continue;
    confident += 1;
    const higherIsBetter = higherIsBetterByMetric.get(edge.metricId) ?? true;
    const good = (edge.lift > 0) === higherIsBetter;
    if (good) confidentGood += 1;
    if (formatByMetric.get(edge.metricId) === "currency") netCurrency += edge.lift;
  }

  // Metrics whose NET confident impact is a good business outcome (and non-zero).
  const net = netConfidentLift(records, edges);
  let metricsImproved = 0;
  for (const rec of records) {
    const value = net.get(rec.metricId) ?? 0;
    const direction = directionOf(value);
    if (direction !== "neutral" && isGoodOutcome(direction, rec.metric.higherIsBetter)) {
      metricsImproved += 1;
    }
  }

  const winRate = confident > 0 ? Math.round((confidentGood / confident) * 100) : 0;

  return [
    {
      label: "Actions Shipped",
      value: String(actionsShipped),
      comparison: "in this workspace",
      tone: "plain",
    },
    {
      label: "Confident Readouts",
      value: String(confident),
      comparison: `of ${evaluatedEdges} edges evaluated`,
      tone: confident > 0 ? "positive" : "neutral",
    },
    {
      label: "Net Business Impact",
      value: formatCurrencyDelta(netCurrency),
      comparison: "confident $-metric edges",
      tone: netCurrency > 0 ? "positive" : netCurrency < 0 ? "negative" : "neutral",
    },
    {
      label: "Gathering Data",
      value: String(insufficient),
      comparison: "< 45 days since ship",
      tone: "neutral",
    },
    {
      label: "Win Rate",
      value: `${winRate}%`,
      comparison: `${confidentGood} / ${confident} confident`,
      tone: winRate >= 50 ? "positive" : "negative",
    },
    {
      label: "Metrics Improved",
      value: `${metricsImproved} / ${records.length}`,
      comparison: "net-positive impact",
      tone: metricsImproved > 0 ? "positive" : "neutral",
    },
  ];
}
