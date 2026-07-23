import assert from "node:assert/strict";
import test from "node:test";
import type { Action, Decision } from "../types.ts";
import { cloneDecisionReport } from "../decision-reports/schema.ts";
import { GUMMY_ALPHA_GOLDEN_EXAMPLE } from "../decision-reports/fixtures/gummy-alpha.ts";
import { numberDecisionActions } from "./action-numbering.ts";

const action = (id: string, sourceItemId?: string): Action => ({
  id,
  pr: 0,
  title: id,
  sourceItemId,
  shippedAt: null,
  primaryMetricId: "metric",
  impact: [],
});

const decision = (id: string, createdAt: string, actionIds: string[]): Decision => ({
  id,
  title: id,
  origin: "decision_report",
  createdAt,
  rationale: { body: [] },
  actionIds,
  leverActionId: null,
  predictions: [],
});

test("numbers decisions oldest-first and actions within each decision", () => {
  const numbered = numberDecisionActions(
    [decision("new", "2026-07-22", ["a3"]), decision("old", "2026-07-21", ["a1", "a2"])],
    [action("a3"), action("a2"), action("a1")],
  );
  assert.deepEqual(
    Object.fromEntries(numbered.map((item) => [item.id, item.displayCode])),
    { a3: "D2A1", a2: "D1A2", a1: "D1A1" },
  );
});

test("report-native numbering follows reviewed source-item order", () => {
  const report = cloneDecisionReport(GUMMY_ALPHA_GOLDEN_EXAMPLE.report);
  report.implementation.actions = [
    { sourceItemId: "first", title: "First", summary: [], owner: null },
    { sourceItemId: "second", title: "Second", summary: [], owner: null },
  ];
  const numbered = numberDecisionActions(
    [decision("decision", "2026-07-22", ["second-id", "first-id"])],
    [action("second-id", "second"), action("first-id", "first")],
    report,
  );
  assert.equal(numbered.find((item) => item.id === "first-id")?.displayCode, "D1A1");
  assert.equal(numbered.find((item) => item.id === "second-id")?.displayCode, "D1A2");
});
