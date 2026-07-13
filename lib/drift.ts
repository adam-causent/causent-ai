// presentDrift() — the pure presenter for the baseline-drift notice (C5/#18).
// Mirrors lib/verdicts.ts presentVerdict: maps the raw DriftReadout to the shape
// the notice renders, so the component stays declarative and the copy is
// unit-tested. Handles three data states; the fourth UI state (restate-clicked) is
// interaction, owned by the component. Metric-value formatting stays in the
// component (formatMetricValue needs the metric's format) — this module is pure
// data + copy, type-only imports, so it runs clean under `node --test`.
//
// Load-bearing design call: a baseline move is a FACT, not a verdict. The presenter
// carries `direction` (the metric's movement) and a neutral magnitude label, and
// NEVER a good/bad judgement — the notice colors the delta neutral/slate, not
// red/green. Glyph + label carry the meaning; color stays neutral (colorblind-safe).

import type { DriftReadout } from "./types";

export type DriftPresentation =
  | {
      kind: "fired";
      /** In-window baseline before the shift (native units; the component formats). */
      preLevel: number;
      /** In-window baseline after the shift (native units; the component formats). */
      postLevel: number;
      /** The baseline's movement — a fact, rendered neutral (never a verdict). */
      direction: "up" | "down";
      /** Neutral magnitude chip, e.g. "DOWN 40%" (metric-format-independent). */
      moveLabel: string;
      /** ISO yyyy-mm-dd of the detected change-point (may be null). */
      shiftDate: string | null;
    }
  | { kind: "gathering" } // NO_BASELINE_YET — "gathering baseline", never a fire
  | { kind: "none" }; // NOT_FIRED, or drift not computed (resolved / engine absent)

export function presentDrift(drift: DriftReadout | null | undefined): DriftPresentation {
  if (!drift || drift.status === "NOT_FIRED") return { kind: "none" };
  if (drift.status === "NO_BASELINE_YET") return { kind: "gathering" };

  const pre = drift.preLevel ?? 0;
  const post = drift.postLevel ?? 0;
  const pct = drift.pctChange ?? 0;
  const direction = drift.direction ?? (post < pre ? "down" : "up");
  const word = direction === "down" ? "DOWN" : "UP";
  return {
    kind: "fired",
    preLevel: pre,
    postLevel: post,
    direction,
    moveLabel: `${word} ${Math.abs(Math.round(pct))}%`,
    shiftDate: drift.shiftDate,
  };
}
