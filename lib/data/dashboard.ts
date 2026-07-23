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
import { unstable_rethrow } from "next/navigation";
import type {
  Action,
  Decision,
  ImpactStat,
  Metric,
  MetricImpact,
  ProjectObjective,
  Report,
  Scope,
} from "@/lib/types";
import { getScope } from "@/lib/data/scope";
import { getActions } from "@/lib/data/actions";
import { getDecisions } from "@/lib/data/decisions";
import { getImpactByMetric, getAggregatedImpact } from "@/lib/data/impact";
import { getObjective } from "@/lib/data/objective";
import { getMetricRecords } from "@/lib/data/metrics";
import {
  getDecisionReports,
  type DashboardDecisionReport,
} from "@/lib/data/decision-reports";
import { selectReportProjectView } from "@/lib/data/report-project-view";
import { numberDecisionActions } from "@/lib/data/action-numbering";
import * as seed from "@/lib/seed";

/** The 30-day-ish reporting window shown in the drawer/impact headers. */
export type ImpactWindow = { start: string; end: string };

/** Everything the dashboard shell + tabs need, from a single source. */
export type DashboardData = {
  scope: Scope;
  metrics: Metric[];
  actions: Action[];
  /** The intent layer: decisions parenting actions + their predictions. */
  decisions: Decision[];
  aggregatedImpact: ImpactStat[];
  impactByMetric: MetricImpact[];
  impactWindow: ImpactWindow;
  /** The project north-star document (null when the workspace has none yet). */
  objective: ProjectObjective | null;
  /** Saved stakeholder reports (empty until a DB-backed reports table exists). */
  reports: Report[];
  /** Durable Decision Reports, newest first. */
  decisionReports: DashboardDecisionReport[];
  /** The activated report currently defining the dashboard project boundary. */
  activeDecisionReport: DashboardDecisionReport | null;
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
    decisions: seed.decisions,
    aggregatedImpact: seed.aggregatedImpact,
    impactByMetric: seed.impactByMetric,
    impactWindow: { start: seed.impactWindow.start, end: seed.impactWindow.end },
    objective: seed.projectObjective,
    reports: seed.reports,
    decisionReports: [],
    activeDecisionReport: null,
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
    const [scope, metricRecords, actions, decisions, aggregatedImpact, impactByMetric, objective, decisionReports] =
      await Promise.all([
        getScope(),
        getMetricRecords(),
        getActions(),
        getDecisions(),
        getAggregatedImpact(),
        getImpactByMetric(),
        getObjective(),
        getDecisionReports(),
      ]);
    const allMetrics = metricRecords.map((record) => record.metric);
    const project = selectReportProjectView({
      reports: decisionReports,
      actions,
      decisions,
      metrics: allMetrics,
      metricUiIdByDbId: new Map(
        metricRecords.map((record) => [record.metricId, record.metric.id]),
      ),
      aggregatedImpact,
      impactByMetric,
    });
    const selectedCoreMetrics = metricRecords
      .filter((record) => record.isCore)
      .map((record) => record.metric);
    const reportAndCoreMetrics = [
      ...project.metrics,
      ...selectedCoreMetrics.filter(
        (metric) => !project.metrics.some((reportMetric) => reportMetric.id === metric.id),
      ),
    ];
    const dashboardMetrics = selectedCoreMetrics.length > 0
      ? project.activeReport
        ? reportAndCoreMetrics
        : selectedCoreMetrics
      : project.activeReport
        ? project.metrics
        : metricRecords.filter((record) => record.configured).map((record) => record.metric);
    const numberedActions = numberDecisionActions(
      project.decisions,
      project.actions,
      project.activeReport?.report ?? null,
    );
    return {
      scope,
      // Direct core-metric selection is the shared dashboard surface. When a
      // report is active, its confirmed metric stays first while selected core
      // metrics are added for the drawer and other tabs; report-owned actions
      // and impact remain isolated below.
      metrics: dashboardMetrics,
      actions: numberedActions,
      decisions: project.decisions,
      aggregatedImpact: project.aggregatedImpact,
      impactByMetric: project.impactByMetric,
      impactWindow: deriveImpactWindow(project.metrics),
      objective: project.activeReport ? null : objective,
      // TODO: source reports from a project-level `reports` table once the
      // schema carries one; until then the DB path has no saved reports.
      reports: [],
      decisionReports,
      activeDecisionReport: project.activeReport,
      source: "db",
    };
  } catch (err) {
    // Next's request-time APIs (cookies/headers) use internal control-flow
    // errors during prerender. They are not Supabase failures and must remain
    // visible to Next so the route is correctly deferred to request time.
    unstable_rethrow(err);
    console.error(
      "[dashboard] Supabase read failed — serving seed fallback so the app stays up:",
      err,
    );
    return seedData();
  }
});
