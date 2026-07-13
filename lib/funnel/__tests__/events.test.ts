// Unit gate for the funnel metrics fold (C2/#15 DoD, C5/#18). Pure — no DB.
// Proves the four DoD metrics compute correctly from raw event rows:
// time-to-first-type (<30s target), Step-4 commit rate, step drop-off, and the
// resolution-return rate.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TIME_TO_FIRST_TYPE_TARGET_MS,
  computeFunnelMetrics,
  median,
  type FunnelEventRow,
} from "../events.ts";

test("median handles empty, odd, and even counts", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5); // mean of the two middles
});

test("empty event set yields null rates, zero counts", () => {
  const m = computeFunnelMetrics([]);
  assert.equal(m.landedRuns, 0);
  assert.equal(m.committedRuns, 0);
  assert.equal(m.commitRate, null);
  assert.equal(m.timeToFirstType.count, 0);
  assert.equal(m.timeToFirstType.medianMs, null);
  assert.equal(m.timeToFirstType.underTargetRate, null);
  assert.equal(m.resolutionReturnRate, null);
  assert.deepEqual(m.dropOffByStep, { paste: 0, card: 0, commit: 0, done: 0 });
});

test("commit rate = committed runs / landed runs, deduped per session", () => {
  const rows: FunnelEventRow[] = [
    // run A: lands, views two steps, commits (duplicate COMMITTED must not double-count)
    { sessionKey: "A", eventType: "LANDED", step: "paste", msSinceStart: null },
    { sessionKey: "A", eventType: "STEP_VIEW", step: "paste", msSinceStart: null },
    { sessionKey: "A", eventType: "STEP_VIEW", step: "card", msSinceStart: null },
    { sessionKey: "A", eventType: "COMMITTED", step: "done", msSinceStart: null },
    { sessionKey: "A", eventType: "COMMITTED", step: "done", msSinceStart: null },
    // run B: lands, drops at card (no commit)
    { sessionKey: "B", eventType: "LANDED", step: "paste", msSinceStart: null },
    { sessionKey: "B", eventType: "STEP_VIEW", step: "paste", msSinceStart: null },
    { sessionKey: "B", eventType: "STEP_VIEW", step: "card", msSinceStart: null },
  ];
  const m = computeFunnelMetrics(rows);
  assert.equal(m.landedRuns, 2);
  assert.equal(m.committedRuns, 1);
  assert.equal(m.commitRate, 0.5);
  // Drop-off: both viewed paste + card, only A reached done via COMMITTED (not a STEP_VIEW at done here).
  assert.equal(m.dropOffByStep.paste, 2);
  assert.equal(m.dropOffByStep.card, 2);
  assert.equal(m.dropOffByStep.commit, 0);
});

test("time-to-first-type: median + under-30s-target rate", () => {
  const under = TIME_TO_FIRST_TYPE_TARGET_MS - 1;
  const over = TIME_TO_FIRST_TYPE_TARGET_MS + 5_000;
  const rows: FunnelEventRow[] = [
    { sessionKey: "A", eventType: "FIRST_TYPE", step: "paste", msSinceStart: 4_000 },
    { sessionKey: "B", eventType: "FIRST_TYPE", step: "paste", msSinceStart: under },
    { sessionKey: "C", eventType: "FIRST_TYPE", step: "paste", msSinceStart: over },
    // a null ms sample is ignored (not counted)
    { sessionKey: "D", eventType: "FIRST_TYPE", step: "paste", msSinceStart: null },
  ];
  const m = computeFunnelMetrics(rows);
  assert.equal(m.timeToFirstType.count, 3);
  assert.equal(m.timeToFirstType.medianMs, under); // middle of [4000, under, over]
  // 2 of 3 under target.
  assert.ok(Math.abs((m.timeToFirstType.underTargetRate ?? 0) - 2 / 3) < 1e-9);
});

test("resolution-return rate = committed runs that came back to a scorecard", () => {
  const rows: FunnelEventRow[] = [
    { sessionKey: "A", eventType: "COMMITTED", step: "done", msSinceStart: null },
    { sessionKey: "A", eventType: "SCORECARD_VIEW", step: null, msSinceStart: null },
    { sessionKey: "B", eventType: "COMMITTED", step: "done", msSinceStart: null },
    // C viewed a scorecard but never committed in-funnel — must not inflate the numerator.
    { sessionKey: "C", eventType: "SCORECARD_VIEW", step: null, msSinceStart: null },
  ];
  const m = computeFunnelMetrics(rows);
  assert.equal(m.committedRuns, 2);
  assert.equal(m.resolutionReturnRate, 0.5); // only A of {A,B} returned
});
