import assert from "node:assert/strict";
import test from "node:test";
import type { Action, Decision, Metric } from "../types.ts";
import type { DashboardDecisionReport } from "./decision-reports.ts";
import { selectReportProjectView } from "./report-project-view.ts";
import { GUMMY_ALPHA_GOLDEN_EXAMPLE } from "../decision-reports/fixtures/gummy-alpha.ts";

const action = (id: string): Action => ({
  id, pr: 0, title: id, shippedAt: null, primaryMetricId: "completion", impact: [],
});
const decision = (id: string, actionIds: string[]): Decision => ({
  id, origin: id === "report-decision" ? "decision_report" : "legacy", title: id,
  createdAt: "2026-07-22", rationale: { body: [] }, actionIds,
  leverActionId: null, predictions: [],
});
const metric = (id: string): Metric => ({
  id, name: id, color: "#000", format: "percent", source: "CSV", cadence: "Daily",
  lastUpdated: "2026-07-22T00:00:00Z", rows: 0, higherIsBetter: true, series: [],
});

function report(): DashboardDecisionReport {
  return {
    id: "report", revisionId: "revision", title: "Report", status: "active",
    updatedAt: "2026-07-22T00:00:00Z", report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    decisionId: "report-decision", predictionId: "prediction", metricId: "metric-uuid",
  };
}

test("an active report isolates every dashboard dataset to its project", () => {
  const view = selectReportProjectView({
    reports: [report()],
    actions: [action("report-action"), action("legacy-action")],
    decisions: [decision("report-decision", ["report-action"]), decision("legacy", ["legacy-action"])],
    metrics: [metric("completion"), metric("arr")],
    metricUiIdByDbId: new Map([["metric-uuid", "completion"]]),
    aggregatedImpact: [{ label: "Improvement Rate", value: "50%", comparison: "legacy", tone: "positive" }],
    impactByMetric: [
      { metricId: "completion", value: 0, label: "—", direction: "neutral", good: true },
      { metricId: "arr", value: 10, label: "+10", direction: "up", good: true },
    ],
  });

  assert.equal(view.activeReport?.id, "report");
  assert.deepEqual(view.decisions.map((item) => item.id), ["report-decision"]);
  assert.deepEqual(view.actions.map((item) => item.id), ["report-action"]);
  assert.deepEqual(view.metrics.map((item) => item.id), ["completion"]);
  assert.deepEqual(view.impactByMetric.map((item) => item.metricId), ["completion"]);
  assert.equal(view.aggregatedImpact[0].value, "—");
});

test("legacy workspaces retain their complete dashboard payload", () => {
  const actions = [action("legacy-action")];
  const decisions = [decision("legacy", ["legacy-action"])];
  const metrics = [metric("arr")];
  const view = selectReportProjectView({
    reports: [], actions, decisions, metrics, metricUiIdByDbId: new Map(),
    aggregatedImpact: [], impactByMetric: [],
  });
  assert.equal(view.activeReport, null);
  assert.equal(view.actions, actions);
  assert.equal(view.decisions, decisions);
  assert.equal(view.metrics, metrics);
});
