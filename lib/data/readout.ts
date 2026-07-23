// Shared mapping from a materialized ACTION -> METRIC readout to a UI ImpactCell.
// Used by both getActions() (per-action cell row) and getImpactByMetric() (per-metric
// aggregate), so the honesty rule lives in exactly one place.

import type { ImpactCell, Metric, MetricFormat } from "../types.ts";
import { formatCount, formatCurrencyDelta, formatPpDelta } from "../format.ts";
import { directionFromEdge, isConfident, isGoodOutcome } from "./config.ts";
import type { EdgeReadout } from "./graph.ts";

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

function directionFromValue(value: number): "up" | "down" | "neutral" {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "neutral";
}

/** CSV percentages commonly arrive as ratios (0.31 = 31%). Existing seeded
 * percentage metrics use points (31 = 31%), so infer the display scale from the
 * connected series rather than silently rounding a real 3.1pp shift to 0.0pp. */
function displayValue(value: number, metric: Metric): number {
  if (
    metric.format === "percent" &&
    metric.series.length > 0 &&
    metric.series.every((observation) => Math.abs(observation.value) <= 1)
  ) {
    return value * 100;
  }
  return value;
}

/**
 * Map one (metric, edge-readout) pair to an ImpactCell. A confident directional
 * ITS edge is authoritative. While ITS is gathering history, an evaluable 14-day
 * mean shift may appear only as an explicitly descriptive preliminary readout.
 */
export function toImpactCell(metric: Metric, edge: EdgeReadout | undefined): ImpactCell {
  if (edge && isConfident(edge.dbDirection, edge.beliefScore) && edge.lift != null) {
    const direction = directionFromEdge(edge.dbDirection);
    const value = displayValue(edge.lift, metric);
    return {
      metricId: metric.id,
      direction,
      value,
      label: formatImpactMagnitude(value, metric.format),
      good: isGoodOutcome(direction, metric.higherIsBetter),
      evidence: "causal",
    };
  }

  // The design contract explicitly keeps the 45-day causal floor while showing
  // an evaluable 14-day mean shift as a labeled descriptive cross-check. It must
  // never inherit the edge's causal direction or belief.
  if (
    edge?.beliefReason === "INSUFFICIENT_HISTORY" &&
    edge.descriptiveLift != null
  ) {
    const direction = directionFromValue(edge.descriptiveLift);
    const value = displayValue(edge.descriptiveLift, metric);
    const overlap = edge.descriptiveClustered
      ? " Overlaps another completed action, so attribution is not isolated."
      : "";
    return {
      metricId: metric.id,
      direction,
      value,
      label: formatImpactMagnitude(value, metric.format),
      good: isGoodOutcome(direction, metric.higherIsBetter),
      evidence: "descriptive",
      detail: `Preliminary 14-day before/after mean shift. Not a causal claim; gathering data for ITS.${overlap}`,
    };
  }

  return neutralCell(metric.id);
}
