// Unit tests for the pure drift presenter (C5/#18). The honesty properties:
//   1. A firing baseline move renders as a FACT — direction + neutral magnitude,
//      never a good/bad judgement.
//   2. Three data states map cleanly; anything not a real fire renders nothing.
//   3. Levels are formatted per the metric's own format (percent / currency).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentDrift, type DriftPresentation } from "../drift.ts";
import type { DriftReadout } from "../types.ts";

function readout(over: Partial<DriftReadout>): DriftReadout {
  return {
    status: "FIRED",
    reason: "fired",
    shiftDate: "2025-04-05",
    preLevel: 20.0,
    postLevel: 12.0,
    deltaNative: -8.0,
    pctChange: -40.0,
    direction: "down",
    ciLow: -8.3,
    ciHigh: -7.8,
    nPre: 49,
    nPost: 49,
    ...over,
  };
}

describe("presentDrift", () => {
  it("FIRED down → fact-shaped fired presentation, neutral magnitude", () => {
    const p = presentDrift(readout({}));
    assert.equal(p.kind, "fired");
    const f = p as Extract<DriftPresentation, { kind: "fired" }>;
    assert.equal(f.preLevel, 20.0);
    assert.equal(f.postLevel, 12.0);
    assert.equal(f.direction, "down");
    assert.equal(f.moveLabel, "DOWN 40%");
    assert.equal(f.shiftDate, "2025-04-05");
  });

  it("FIRED up → UP label and up direction", () => {
    const p = presentDrift(
      readout({ direction: "up", preLevel: 10, postLevel: 13, pctChange: 30 }),
    );
    const f = p as Extract<DriftPresentation, { kind: "fired" }>;
    assert.equal(f.direction, "up");
    assert.equal(f.moveLabel, "UP 30%");
  });

  it("moveLabel rounds the magnitude and is metric-format-independent", () => {
    const p = presentDrift(readout({ pctChange: -39.6 }));
    const f = p as Extract<DriftPresentation, { kind: "fired" }>;
    assert.equal(f.moveLabel, "DOWN 40%");
  });

  it("NO_BASELINE_YET → gathering", () => {
    assert.equal(presentDrift(readout({ status: "NO_BASELINE_YET" })).kind, "gathering");
  });

  it("NOT_FIRED → none", () => {
    assert.equal(presentDrift(readout({ status: "NOT_FIRED" })).kind, "none");
  });

  it("null / undefined drift → none (never throws)", () => {
    assert.equal(presentDrift(null).kind, "none");
    assert.equal(presentDrift(undefined).kind, "none");
  });

  it("missing direction falls back to the sign of the move", () => {
    const p = presentDrift(readout({ direction: null, preLevel: 20, postLevel: 12 }));
    const f = p as Extract<DriftPresentation, { kind: "fired" }>;
    assert.equal(f.direction, "down");
  });
});
