// The single entry point the (dashboard) Server Components read. It fetches the whole
// dashboard payload from Supabase (via the lib/data/* mappers) in one shot, and — so
// the app can never white-screen — falls back to the deterministic seed dataset when
// CAUSENT_USE_SEED=1 is set OR any DB read throws. Wrapped in React cache() so the
// shared layout and the active page that both render for one request share one load
// instead of each re-querying.
//
// SERVER-ONLY: transitively imports lib/supabase-server.ts. Never import from a Client
// Component — pass the returned plain data down as props instead.

import { cache } from "react";
import type {
  Action,
  ImpactStat,
  Metric,
  MetricImpact,
  ProjectObjective,
  Report,
  Scope,
} from "@/lib/types";
import { getScope } from "@/lib/data/scope";
import { getMetrics } from "@/lib/data/metrics";
import { getActions } from "@/lib/data/actions";
import { getImpactByMetric, getAggregatedImpact } from "@/lib/data/impact";
import { getObjective } from "@/lib/data/objective";
import * as seed from "@/lib/seed";

/** The 30-day-ish reporting window shown in the drawer/impact headers. */
export type ImpactWindow = { start: string; end: string };

/** Everything the dashboard shell + tabs need, from a single source. */
export type DashboardData = {
  scope: Scope;
  metrics: Metric[];
  actions: Action[];
  aggregatedImpact: ImpactStat[];
  impactByMetric: MetricImpact[];
  impactWindow: ImpactWindow;
  /** The project north-star document (null when the workspace has none yet). */
  objective: ProjectObjective | null;
  /** Saved stakeholder reports (empty until a DB-backed reports table exists). */
  reports: Report[];
  /** Which source actually served this payload (for diagnostics/telemetry). */
  source: "db" | "seed";
};

/**
 * The reporting window: the last 30 days present in the metric series (inclusive),
 * derived from real data so it stays honest instead of a hard-coded constant.
 */
function deriveImpactWindow(metrics: Metric[]): ImpactWindow {
  const series = metrics.find((m) => m.series.length > 0)?.series ?? [];
  if (series.length === 0) return { start: "", end: "" };
  const end = series[series.length - 1].date;
  const start = series[Math.max(0, series.length - 30)].date;
  return { start, end };
}

/** The deterministic seed payload, shaped exactly like a DB read. */
function seedData(): DashboardData {
  return {
    scope: seed.scope,
    metrics: seed.metrics,
    actions: seed.actions,
    aggregatedImpact: seed.aggregatedImpact,
    impactByMetric: seed.impactByMetric,
    impactWindow: { start: seed.impactWindow.start, end: seed.impactWindow.end },
    objective: seed.projectObjective,
    reports: seed.reports,
    source: "seed",
  };
}

/** True when the operator has pinned the app to the seed dataset. */
function seedForced(): boolean {
  return process.env.CAUSENT_USE_SEED === "1";
}

/**
 * Load the full dashboard payload. Reads Supabase unless CAUSENT_USE_SEED=1; on ANY DB
 * error it logs and falls back to seed so a tab never white-screens. Memoized per
 * request (React cache): layout + page share the same load.
 */
export const loadDashboardData = cache(async function loadDashboardData(): Promise<
  DashboardData
> {
  if (seedForced()) return seedData();

  try {
    const [scope, metrics, actions, aggregatedImpact, impactByMetric, objective] =
      await Promise.all([
        getScope(),
        getMetrics(),
        getActions(),
        getAggregatedImpact(),
        getImpactByMetric(),
        getObjective(),
      ]);
    return {
      scope,
      metrics,
      actions,
      aggregatedImpact,
      impactByMetric,
      impactWindow: deriveImpactWindow(metrics),
      objective,
      // TODO: source reports from a project-level `reports` table once the
      // schema carries one; until then the DB path has no saved reports.
      reports: [],
      source: "db",
    };
  } catch (err) {
    console.error(
      "[dashboard] Supabase read failed — serving seed fallback so the app stays up:",
      err,
    );
    return seedData();
  }
});
