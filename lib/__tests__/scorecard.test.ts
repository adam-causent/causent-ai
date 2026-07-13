// Unit gate for the resolution scorecard's verdict→UI mapping + predicted-vs-
// measured shaping (C5/#18). Pure — no DB. Proves every verdict class routes to
// an honest surface (never a blank/error) and that the measured side is shaped
// onto the same %-of-mean scale the human committed on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_VERDICTS, VERDICT_PRESENTATION, presentVerdict } from "../verdicts.ts";
import { scorecardKind, shapeScorecard } from "../scorecard.ts";
import type { PredictionVerdict } from "../types.ts";

test("every verdict — all 9 — has a complete presentation", () => {
  assert.equal(ALL_VERDICTS.length, 9);
  assert.ok(ALL_VERDICTS.includes("UNMEASURABLE_NO_METRIC"));
  for (const v of ALL_VERDICTS) {
    const p = presentVerdict(v);
    assert.equal(p.verdict, v);
    assert.ok(p.label.length > 0, `${v} label`);
    assert.ok(p.caveat.length > 0, `${v} caveat`);
    assert.ok(p.glyph.length > 0, `${v} glyph`); // colorblind-safe: never color-alone
  }
  // GATHERING is the only non-terminal (it re-measures).
  const nonTerminal = ALL_VERDICTS.filter((v) => !VERDICT_PRESENTATION[v].terminal);
  assert.deepEqual(nonTerminal, ["GATHERING"]);
});

test("scorecardKind routes each verdict class to its surface", () => {
  const expected: Record<PredictionVerdict, string> = {
    CONFIRMED: "measured",
    DIRECTION_CONFIRMED: "measured",
    REFUTED: "measured",
    INCONCLUSIVE: "no-signal",
    UNRESOLVABLE: "no-signal",
    VOIDED: "no-lever",
    UNATTRIBUTED: "no-lever",
    GATHERING: "gathering",
    UNMEASURABLE_NO_METRIC: "unmeasurable",
  };
  for (const v of ALL_VERDICTS) {
    assert.equal(scorecardKind(v), expected[v], v);
  }
});

test("CONFIRMED: predicted + measured shaped onto one %-of-mean scale", () => {
  // pre_window_mean = 2000; native lift 260 -> 13% of mean; CI [200,320] -> [10%,16%].
  const sc = shapeScorecard({
    verdict: "CONFIRMED",
    committedDirection: "POSITIVE",
    committedMagnitudePct: 13.5,
    tuple: {
      predicted_direction: "POSITIVE",
      predicted_magnitude_pct: 13.5,
      predicted_native: 270,
      pre_window_mean: 2000,
      measured_lift: 260,
      measured_pct: 13,
      ci_low: 200,
      ci_high: 320,
      belief_score: 1,
      belief_reason: null,
      verdict: "CONFIRMED",
    },
  });
  assert.equal(sc.kind, "measured");
  assert.equal(sc.predicted.magnitudePct, 13.5);
  assert.ok(sc.measured);
  assert.equal(sc.measured!.pct, 13);
  assert.equal(sc.measured!.direction, "up");
  assert.ok(Math.abs(sc.measured!.ciLowPct! - 10) < 1e-9);
  assert.ok(Math.abs(sc.measured!.ciHighPct! - 16) < 1e-9);
  assert.equal(sc.presentation.tone, "positive"); // drives the measured Delta's "good"
});

test("REFUTED: measured present, negative tone, direction from sign", () => {
  const sc = shapeScorecard({
    verdict: "REFUTED",
    committedDirection: "POSITIVE",
    committedMagnitudePct: 5,
    tuple: {
      pre_window_mean: 1000,
      measured_lift: -80,
      measured_pct: -8,
      ci_low: -140,
      ci_high: -20,
      verdict: "REFUTED",
    },
  });
  assert.equal(sc.kind, "measured");
  assert.equal(sc.measured!.pct, -8);
  assert.equal(sc.measured!.direction, "down");
  assert.equal(sc.presentation.tone, "negative");
});

test("UNMEASURABLE_NO_METRIC: no measured side, unmeasurable surface", () => {
  const sc = shapeScorecard({
    verdict: "UNMEASURABLE_NO_METRIC",
    committedDirection: "POSITIVE",
    committedMagnitudePct: 20,
    tuple: { predicted_direction: "POSITIVE", predicted_magnitude_pct: 20, verdict: "UNMEASURABLE_NO_METRIC" },
  });
  assert.equal(sc.kind, "unmeasurable");
  assert.equal(sc.measured, null);
  assert.equal(sc.predicted.magnitudePct, 20); // the human commitment still shows
});

test("GATHERING: not-yet, no measured number", () => {
  const sc = shapeScorecard({
    verdict: "GATHERING",
    committedDirection: "POSITIVE",
    committedMagnitudePct: 4,
    tuple: { pre_window_mean: 50, verdict: "GATHERING" },
  });
  assert.equal(sc.kind, "gathering");
  assert.equal(sc.measured, null);
});

test("INCONCLUSIVE with no recorded measurement shows no measured block", () => {
  const sc = shapeScorecard({
    verdict: "INCONCLUSIVE",
    committedDirection: "NEGATIVE",
    committedMagnitudePct: 5,
    tuple: { pre_window_mean: 100, verdict: "INCONCLUSIVE" }, // no measured_pct/lift/reason
  });
  assert.equal(sc.kind, "no-signal");
  assert.equal(sc.measured, null); // nothing to show, but not an error
});

test("null tuple never throws — no-lever verdicts have no measured side", () => {
  for (const v of ["VOIDED", "UNATTRIBUTED"] as PredictionVerdict[]) {
    const sc = shapeScorecard({
      verdict: v,
      committedDirection: "POSITIVE",
      committedMagnitudePct: 6,
      tuple: null,
    });
    assert.equal(sc.kind, "no-lever");
    assert.equal(sc.measured, null);
  }
});
