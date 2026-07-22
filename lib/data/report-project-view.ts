import type { Action, Decision, ImpactStat, Metric, MetricImpact } from "@/lib/types";
import type { DashboardDecisionReport } from "@/lib/data/decision-reports";

export type ReportProjectView = {
  activeReport: DashboardDecisionReport | null;
  actions: Action[];
  decisions: Decision[];
  metrics: Metric[];
  aggregatedImpact: ImpactStat[];
  impactByMetric: MetricImpact[];
};

/**
 * An activated report is a project boundary inside the legacy shared demo workspace.
 * Only its canonical decision, selected actions, and confirmed metric may cross it.
 */
export function selectReportProjectView(input: {
  reports: DashboardDecisionReport[];
  actions: Action[];
  decisions: Decision[];
  metrics: Metric[];
  metricUiIdByDbId: Map<string, string>;
  aggregatedImpact: ImpactStat[];
  impactByMetric: MetricImpact[];
}): ReportProjectView {
  const activeReport = input.reports.find(
    (report) => report.status === "active" && report.decisionId && report.metricId,
  ) ?? null;
  if (!activeReport) {
    return {
      activeReport: null,
      actions: input.actions,
      decisions: input.decisions,
      metrics: input.metrics,
      aggregatedImpact: input.aggregatedImpact,
      impactByMetric: input.impactByMetric,
    };
  }

  const decisions = input.decisions.filter(
    (decision) => decision.id === activeReport.decisionId,
  );
  const actionIds = new Set(decisions.flatMap((decision) => decision.actionIds));
  const actions = input.actions.filter((action) => actionIds.has(action.id));
  const metricUiId = activeReport.metricId
    ? input.metricUiIdByDbId.get(activeReport.metricId) ?? null
    : null;
  const metrics = metricUiId
    ? input.metrics.filter((metric) => metric.id === metricUiId)
    : [];
  const impactByMetric = metricUiId
    ? input.impactByMetric.filter((impact) => impact.metricId === metricUiId)
    : [];

  return {
    activeReport,
    actions,
    decisions,
    metrics,
    // Activation deliberately creates no evidence. Until this report's selected
    // actions have readouts, a workspace-wide improvement rate would be a leak.
    aggregatedImpact: [{
      label: "Improvement Rate",
      value: "—",
      comparison: "0 / 0 confident readouts for this report",
      tone: "plain",
    }],
    impactByMetric,
  };
}
