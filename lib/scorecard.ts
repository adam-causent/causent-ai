// Resolution scorecard — the PURE shaping layer (C5/#18).
//
// "You said +3%. Here's what happened." At resolution_date the engine
// (persistence/resolve.py) writes a memory tuple onto the prediction; this
// module shapes that tuple + the human commitment into the predicted-vs-measured
// view the Scorecard renders. It does NOT re-implement the resolution math — it
// only reads what resolve.py already computed (measured_pct, ci bounds, belief
// reason) and converts the native CI bounds onto the same %-of-mean scale the
// human committed on, so both sides of the comparison share one denominator.
//
// Verdict → surface routing (caveat-first, never a blank/error):
//   measured     CONFIRMED / DIRECTION_CONFIRMED / REFUTED — show predicted vs measured
//   gathering    GATHERING — not-yet; the engine already extended the date
//   unmeasurable UNMEASURABLE_NO_METRIC — connect-the-metric / self-report prompt
//   no-signal    INCONCLUSIVE / UNRESOLVABLE — measured, but no confident number
//   no-lever     VOIDED / UNATTRIBUTED — nothing shipped/mapped to measure

import type {
  Direction,
  PredictionDirection,
  PredictionVerdict,
  ResolutionTuple,
} from "./types.ts";
import { presentVerdict, type VerdictPresentation } from "./verdicts.ts";

export type { ResolutionTuple };

export type ScorecardKind =
  | "measured"
  | "gathering"
  | "unmeasurable"
  | "no-signal"
  | "no-lever";

export type ScorecardMeasured = {
  /** Measured lift as %-of-mean (signed); null when the engine withheld it. */
  pct: number | null;
  /** Native measured lift (ITS step coefficient); display/audit. */
  native: number | null;
  /** Metric movement direction (glyph axis), derived from the measured sign. */
  direction: Direction;
  /** Confidence interval on the %-of-mean scale (shares the predicted denom). */
  ciLowPct: number | null;
  ciHighPct: number | null;
  /** The engine's belief reason (e.g. FDR_DEMOTED / AUTOCORRELATION), if any. */
  beliefReason: string | null;
};

export type ScorecardData = {
  verdict: PredictionVerdict;
  presentation: VerdictPresentation;
  kind: ScorecardKind;
  predicted: {
    direction: PredictionDirection;
    magnitudePct: number;
    native: number | null;
  };
  /** null for gathering / unmeasurable / no-lever surfaces. */
  measured: ScorecardMeasured | null;
};

const MEASURED_VERDICTS = new Set<PredictionVerdict>([
  "CONFIRMED",
  "DIRECTION_CONFIRMED",
  "REFUTED",
]);
const NO_SIGNAL_VERDICTS = new Set<PredictionVerdict>(["INCONCLUSIVE", "UNRESOLVABLE"]);
const NO_LEVER_VERDICTS = new Set<PredictionVerdict>(["VOIDED", "UNATTRIBUTED"]);

/** Which scorecard surface a verdict routes to. */
export function scorecardKind(verdict: PredictionVerdict): ScorecardKind {
  if (verdict === "GATHERING") return "gathering";
  if (verdict === "UNMEASURABLE_NO_METRIC") return "unmeasurable";
  if (MEASURED_VERDICTS.has(verdict)) return "measured";
  if (NO_SIGNAL_VERDICTS.has(verdict)) return "no-signal";
  if (NO_LEVER_VERDICTS.has(verdict)) return "no-lever";
  return "no-signal";
}

function directionFromSign(pct: number | null): Direction {
  if (pct === null || pct === 0) return "neutral";
  return pct > 0 ? "up" : "down";
}

/** Native → %-of-mean on the SAME denominator the predicted side used. */
function toPct(native: number | null | undefined, denom: number | null | undefined): number | null {
  if (typeof native !== "number" || !Number.isFinite(native)) return null;
  if (typeof denom !== "number" || !Number.isFinite(denom) || denom === 0) return null;
  return (native / Math.abs(denom)) * 100;
}

/**
 * Shape a resolved prediction into the scorecard view. `committedMagnitudePct`
 * and `committedDirection` are the authoritative human commitment (from the
 * predictions row); the tuple supplies the measured side.
 */
export function shapeScorecard(input: {
  verdict: PredictionVerdict;
  committedDirection: PredictionDirection;
  committedMagnitudePct: number;
  tuple: ResolutionTuple;
}): ScorecardData {
  const { verdict, committedDirection, committedMagnitudePct, tuple } = input;
  const kind = scorecardKind(verdict);
  const presentation = presentVerdict(verdict);

  const predicted = {
    direction: committedDirection,
    magnitudePct: committedMagnitudePct,
    native:
      typeof tuple?.predicted_native === "number" ? tuple.predicted_native : null,
  };

  // Only the measured surfaces carry a predicted-vs-measured comparison. A
  // no-signal verdict (INCONCLUSIVE/UNRESOLVABLE) still had a measurement
  // attempt, so surface the measured pct when the engine recorded one.
  if (kind === "measured" || kind === "no-signal") {
    const denom = tuple?.pre_window_mean ?? null;
    const measuredPct =
      typeof tuple?.measured_pct === "number" ? tuple.measured_pct : null;
    const measured: ScorecardMeasured = {
      pct: measuredPct,
      native: typeof tuple?.measured_lift === "number" ? tuple.measured_lift : null,
      direction: directionFromSign(measuredPct),
      ciLowPct: toPct(tuple?.ci_low, denom),
      ciHighPct: toPct(tuple?.ci_high, denom),
      beliefReason: tuple?.belief_reason ?? null,
    };
    // A no-signal verdict with no recorded measurement has nothing to show.
    const hasMeasurement =
      measured.pct !== null || measured.native !== null || measured.beliefReason !== null;
    return { verdict, presentation, kind, predicted, measured: hasMeasurement ? measured : null };
  }

  return { verdict, presentation, kind, predicted, measured: null };
}
