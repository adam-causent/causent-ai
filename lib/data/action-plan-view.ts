import type { Action, Decision, Metric } from "@/lib/types";

export type ActionPlanView = {
  mode: "decision_report" | "legacy";
  actions: Action[];
  decisions: Decision[];
  showLegacyObjective: boolean;
};

export type ReportMetricView = {
  decision: Decision;
  metric: Metric | null;
  metricLabel: string | null;
  actions: Action[];
};

/**
 * The partner Decision Report flow must not inherit the deterministic study
 * that still occupies the shared demo workspace. Once report-origin decisions
 * exist, they define the Actions & Decisions dataset and the legacy objective
 * is suppressed. Workspaces without a report plan retain the existing view.
 */
export function selectActionPlanView(
  decisions: Decision[],
  actions: Action[],
): ActionPlanView {
  const reportDecisions = decisions.filter(
    (decision) => decision.origin === "decision_report",
  );
  if (reportDecisions.length === 0) {
    return {
      mode: "legacy",
      actions,
      decisions,
      showLegacyObjective: true,
    };
  }

  const reportActionIds = new Set(
    reportDecisions.flatMap((decision) => decision.actionIds),
  );
  return {
    mode: "decision_report",
    actions: actions.filter((action) => reportActionIds.has(action.id)),
    decisions: reportDecisions,
    showLegacyObjective: false,
  };
}

/** Focus the persistent metrics drawer on the report decision selected by URL. */
export function selectReportMetricView(
  selectedDecisionId: string | null,
  decisions: Decision[],
  metrics: Metric[],
  actions: Action[],
): ReportMetricView | null {
  if (!selectedDecisionId) return null;
  const decision = decisions.find(
    (candidate) =>
      candidate.id === selectedDecisionId && candidate.origin === "decision_report",
  );
  if (!decision) return null;

  const metricLabel = decision.predictions[0]?.metricId ?? null;
  const metric = metricLabel
    ? metrics.find(
        (candidate) => candidate.id === metricLabel || candidate.name === metricLabel,
      ) ?? null
    : null;
  const actionIds = new Set(decision.actionIds);
  return {
    decision,
    metric,
    metricLabel,
    actions: actions.filter((action) => actionIds.has(action.id)),
  };
}
