// Shared mapping config for the Supabase-backed data layer. The DB stores metrics
// by human name + unit (see supabase/migrations + engine/persistence/seed_demo.py);
// the UI keys everything by a stable slug (lib/types.ts, lib/seed.ts). This module
// is the single translation table between the two, plus the honesty rules the
// readout mapping depends on.

import type { Direction, MetricFormat } from "@/lib/types";

/**
 * The demo workspace the v1 UI reads. Every query in lib/data/* is pinned here so
 * the service-role client (lib/supabase-server.ts) can never read across tenants.
 *
 * TODO(auth): once reads run under an RLS-scoped user client, this pin goes away —
 * the scope comes from the caller's membership and RLS enforces isolation.
 */
export const DEMO_SCOPE_ID = "ca5e0000-0000-0000-0000-0000000000d3";

/** Per-metric UI config, keyed by the metric's DB `name`. Mirrors lib/seed.ts. */
export type MetricConfig = {
  /** Stable UI slug (lib/types.ts Metric.id). */
  id: string;
  /** Brand-safe series color (hex), matching lib/seed.ts COLORS. */
  color: string;
  /** For this metric, is "up" a good business outcome? churn/support are inverted. */
  higherIsBetter: boolean;
};

/**
 * DB metric name -> UI config. Names match engine/persistence/seed_demo.py METRICS.
 * Order here is the canonical UI order (matches lib/seed.ts metrics[]).
 */
export const METRIC_CONFIG_BY_NAME: Record<string, MetricConfig> = {
  ARR: { id: "arr", color: "#00A29C", higherIsBetter: true },
  "Activation Rate": { id: "activation", color: "#377DED", higherIsBetter: true },
  "Churn Rate": { id: "churn", color: "#E5484D", higherIsBetter: false },
  "Gross Profit": { id: "grossProfit", color: "#F0B73E", higherIsBetter: true },
  "Support Tickets": { id: "support", color: "#8B5CF6", higherIsBetter: false },
};

/** Canonical UI metric order (slugs), matching lib/seed.ts metrics[]. */
export const METRIC_ORDER = ["arr", "activation", "churn", "grossProfit", "support"];

/** Lookup config by slug (used when we only have the UI id in hand). */
export const METRIC_CONFIG_BY_SLUG: Record<string, MetricConfig & { name: string }> =
  Object.fromEntries(
    Object.entries(METRIC_CONFIG_BY_NAME).map(([name, cfg]) => [cfg.id, { ...cfg, name }]),
  );

/** DB metrics.unit -> UI MetricFormat. */
export function formatFromUnit(unit: string | null): MetricFormat {
  switch (unit) {
    case "USD":
      return "currency";
    case "percent":
      return "percent";
    default:
      return "count";
  }
}

/** DB metrics.source -> UI Metric.source label. */
export function sourceLabel(source: string): "CSV" | "Postgres" | "BigQuery" {
  return source === "connector" ? "Postgres" : "CSV";
}

/** engine causal_edges.direction -> UI Direction (metric-movement direction). */
export function directionFromEdge(dbDirection: string): Direction {
  if (dbDirection === "POSITIVE") return "up";
  if (dbDirection === "NEGATIVE") return "down";
  return "neutral";
}

/**
 * Whether a metric moving in `direction` is a good business outcome. Mirrors
 * lib/derive.ts: a neutral (no-effect) cell is treated as good/plain.
 */
export function isGoodOutcome(direction: Direction, higherIsBetter: boolean): boolean {
  if (direction === "neutral") return true;
  return (direction === "up") === higherIsBetter;
}

/**
 * The product's honesty bar for asserting a causal impact: a CONFIDENT (belief 1.0)
 * directional edge. Below it — INCONCLUSIVE, demoted, or belief withheld
 * (INSUFFICIENT_HISTORY, "gathering data") — we show no number (see lib/data/graph.ts).
 * Matches engine FLOOR_CONFIDENT semantics: belief reaches 1.0 only with >= 45 daily
 * points on each side of the ship date.
 */
export function isConfident(
  dbDirection: string,
  beliefScore: number | null,
): boolean {
  return dbDirection !== "INCONCLUSIVE" && beliefScore === 1;
}
