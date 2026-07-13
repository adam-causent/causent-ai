// Capture-flow validation tests (epic #6, #10): no engine prefill (structural),
// UNATTRIBUTED warning, one-lever invariant, revision-requires-reason, and the
// 9-state verdict presentation map (UNMEASURABLE_NO_METRIC added in C5/#18).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  leverChange,
  predictionWarnings,
  validatePrediction,
  validateRevision,
  type PredictionInput,
} from "../predictions.ts";
import { ALL_VERDICTS, VERDICT_PRESENTATION } from "../verdicts.ts";

function input(over: Partial<PredictionInput> = {}): PredictionInput {
  return {
    metricId: "arr",
    direction: "POSITIVE",
    magnitudePctMean: 5,
    resolutionDate: "2025-08-01",
    leverActionId: "a-8107",
    ...over,
  };
}

describe("validatePrediction", () => {
  it("accepts a complete human commitment", () => {
    assert.deepEqual(validatePrediction(input()), []);
  });

  it("rejects a missing metric, bad direction, and non-positive magnitude", () => {
    const errors = validatePrediction(
      input({ metricId: "", direction: "SIDEWAYS" as never, magnitudePctMean: 0 }),
    );
    assert.equal(errors.length, 3);
  });

  it("rejects NaN/Infinity magnitudes and malformed dates", () => {
    assert.equal(validatePrediction(input({ magnitudePctMean: NaN })).length, 1);
    assert.equal(validatePrediction(input({ magnitudePctMean: Infinity })).length, 1);
    assert.equal(validatePrediction(input({ resolutionDate: "soon" })).length, 1);
    assert.equal(validatePrediction(input({ resolutionDate: "2025-13-45" })).length, 1);
  });
});

describe("predictionWarnings — UNATTRIBUTED", () => {
  it("warns when no lever is mapped", () => {
    const w = predictionWarnings(input({ leverActionId: null }));
    assert.equal(w.length, 1);
    assert.match(w[0], /UNATTRIBUTED/);
  });

  it("stays silent when a lever is mapped", () => {
    assert.deepEqual(predictionWarnings(input()), []);
  });
});

describe("leverChange — one lever per decision (v1)", () => {
  it("set / replace / noop", () => {
    assert.equal(leverChange(null, "a-1"), "set");
    assert.equal(leverChange("a-1", "a-2"), "replace"); // swap, never a second lever
    assert.equal(leverChange("a-1", "a-1"), "noop");
  });
});

describe("validateRevision — a revision is data, not a failure", () => {
  it("requires a positive magnitude AND a logged reason", () => {
    assert.equal(validateRevision({ newMagnitudePct: 3, reason: "pilot data came in" }).length, 0);
    assert.equal(validateRevision({ newMagnitudePct: 0, reason: "pilot data came in" }).length, 1);
    assert.equal(validateRevision({ newMagnitudePct: 3, reason: "" }).length, 1);
    assert.equal(validateRevision({ newMagnitudePct: 3, reason: "  ok" }).length, 1);
  });
});

describe("verdict presentation map", () => {
  it("covers all 9 verdicts with label, caveat, glyph, and tone", () => {
    assert.equal(ALL_VERDICTS.length, 9);
    for (const v of ALL_VERDICTS) {
      const p = VERDICT_PRESENTATION[v];
      assert.equal(p.verdict, v);
      assert.ok(p.label.length > 0, `${v} label`);
      assert.ok(p.caveat.length > 10, `${v} caveat leads the readout`);
      assert.ok(p.glyph.length > 0, `${v} glyph (colorblind-safe, never color alone)`);
      assert.ok(["positive", "negative", "neutral", "plain"].includes(p.tone));
    }
  });

  it("only GATHERING is non-terminal (it re-measures)", () => {
    const nonTerminal = ALL_VERDICTS.filter((v) => !VERDICT_PRESENTATION[v].terminal);
    assert.deepEqual(nonTerminal, ["GATHERING"]);
  });
});
