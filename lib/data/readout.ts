// Shared mapping from a materialized ACTION -> METRIC readout to a UI ImpactCell.
// Used by both getActions() (per-action cell row) and getImpactByMetric() (per-metric
// aggregate), so the honesty rule lives in exactly one place.

import type { ImpactCell, Metric, MetricFormat } from "@/lib/types";
import { formatCount, formatCurrencyDelta, formatPpDelta } from "@/lib/format";
import { directionFromEdge, isConfident, isGoodOutcome } from "@/lib/data/config";
import type { EdgeReadout } from "@/lib/data/graph";

/** Signed magnitude label per metric format. Mirrors lib/derive.ts. */
export function formatImpactMagnitude(value: number, format: MetricFormat): string {
  if (format === "currency") return formatCurrencyDelta(value);
  if (format === "percent") return formatPpDelta(value);
  return `${value > 0 ? "+" : ""}${formatCount(value)}`;
}

/** The neutral "no measured effect" cell for a metric ("—"). */
export function neutralCell(metricId: string): ImpactCell {
  return { metricId, direction: "neutral", value: null, label: "—", good: true };
}

/**
 * Map one (metric, edge-readout) pair to an ImpactCell. Honest rule: a signed number
 * is shown ONLY for a CONFIDENT directional edge (belief 1.0 — the engine's
 * FLOOR_CONFIDENT bar). No edge, INCONCLUSIVE, FDR-demoted, or belief withheld
 * (INSUFFICIENT_HISTORY, "gathering data") all collapse to a neutral "—" cell. The
 * value is the engine's ITS lift — never fabricated.
 */
export function toImpactCell(metric: Metric, edge: EdgeReadout | undefined): ImpactCell {
  if (!edge || !isConfident(edge.dbDirection, edge.beliefScore) || edge.lift == null) {
    return neutralCell(metric.id);
  }
  const direction = directionFromEdge(edge.dbDirection);
  return {
    metricId: metric.id,
    direction,
    value: edge.lift,
    label: formatImpactMagnitude(edge.lift, metric.format),
    good: isGoodOutcome(direction, metric.higherIsBetter),
  };
}
