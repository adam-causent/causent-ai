import assert from "node:assert/strict";
import test from "node:test";

import { selectActionPlanView, selectReportMetricView } from "./action-plan-view.ts";
import type { Action, Decision, Metric } from "../types.ts";

function decision(
  id: string,
  origin: Decision["origin"],
  actionIds: string[],
): Decision {
  return {
    id,
    origin,
    title: id,
    createdAt: "2026-07-22",
    rationale: { body: [] },
    actionIds,
    leverActionId: null,
    predictions: [],
  };
}

function action(id: string): Action {
  return {
    id,
    pr: 0,
    title: id,
    shippedAt: null,
    primaryMetricId: "metric",
    impact: [],
  };
}

test("Decision Report plans exclude the deterministic objective and legacy study rows", () => {
  const view = selectActionPlanView(
    [
      decision("report-decision", "decision_report", ["report-action"]),
      decision("legacy-decision", "legacy", ["legacy-action"]),
    ],
    [action("report-action"), action("legacy-action"), action("ungrouped-legacy")],
  );

  assert.equal(view.mode, "decision_report");
  assert.equal(view.showLegacyObjective, false);
  assert.deepEqual(view.decisions.map(({ id }) => id), ["report-decision"]);
  assert.deepEqual(view.actions.map(({ id }) => id), ["report-action"]);
});

test("workspaces without a Decision Report retain the existing dataset", () => {
  const decisions = [decision("legacy-decision", "legacy", ["legacy-action"])];
  const actions = [action("legacy-action")];
  const view = selectActionPlanView(decisions, actions);

  assert.equal(view.mode, "legacy");
  assert.equal(view.showLegacyObjective, true);
  assert.equal(view.decisions, decisions);
  assert.equal(view.actions, actions);
});

test("the metrics drawer focuses on the selected report metric and its actions", () => {
  const reportDecision = decision(
    "report-decision",
    "decision_report",
    ["report-action"],
  );
  reportDecision.predictions = [{
    id: "prediction",
    metricId: "Completion rate",
    direction: "POSITIVE",
    magnitudePctMean: 15,
    resolutionDate: "2026-08-22",
    committedAt: "2026-07-22",
    verdict: null,
    resolvedAt: null,
    measuredPct: null,
    revisions: [],
  }];
  const metric: Metric = {
    id: "completion",
    name: "Completion rate",
    color: "#00A29C",
    format: "percent",
    source: "CSV",
    cadence: "Daily",
    lastUpdated: "2026-07-22T00:00:00Z",
    rows: 0,
    higherIsBetter: true,
    series: [],
  };

  const view = selectReportMetricView(
    reportDecision.id,
    [reportDecision, decision("legacy", "legacy", ["legacy-action"])],
    [metric],
    [action("report-action"), action("legacy-action")],
  );

  assert.equal(view?.metric, metric);
  assert.equal(view?.metricLabel, "Completion rate");
  assert.deepEqual(view?.actions.map(({ id }) => id), ["report-action"]);
});

test("an unconfigured report metric remains visible as an honest missing-data label", () => {
  const reportDecision = decision("report-decision", "decision_report", []);
  reportDecision.predictions = [{
    id: "prediction",
    metricId: "Flavor-combination completion rate",
    direction: "POSITIVE",
    magnitudePctMean: 15,
    resolutionDate: "2026-08-22",
    committedAt: "2026-07-22",
    verdict: null,
    resolvedAt: null,
    measuredPct: null,
    revisions: [],
  }];

  const view = selectReportMetricView(reportDecision.id, [reportDecision], [], []);

  assert.equal(view?.metric, null);
  assert.equal(view?.metricLabel, "Flavor-combination completion rate");
});
