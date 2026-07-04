// Deterministic honest-summary generator (Phase B1 core).
//
// The CORE is pure templating over the numbers — NO LLM. Given a ReadoutRow it
// resolves a single ClaimStrength from the engine's belief (projected DOWN only,
// never up) and renders honest prose around it. An optional LLM "polish" seam
// (generate.polish.ts) can rephrase the prose, but it is OFF by default and can
// never upgrade the claim — enforceInvariants clamps it back to this core's verdict.
//
// Honest-claim rules enforced here (eng-review decision #5):
//   1. Never upgrades/invents a claim — strength comes only from belief.score,
//      and a 1.0 handed in below the 45/45 floor is defensively downgraded.
//   2. Directional estimates LEAD with "Estimated impact, not proven".
//   3. The method is always named (OLS ITS).
//   4. Below FLOOR_CONFIDENT on either side -> "gathering data" (no claim).
//   5. The naive 14-day method is always marked DESCRIPTIVE, never causal.
//   6. The naive method's (often tighter) CI is NEVER presented as more trustworthy.
//   7. On ITS-vs-descriptive disagreement, the caveat is WIDENED.

import { formatCurrencyDelta, formatPpDelta, formatCount, formatLongDate } from "../format.ts";
import type { MetricFormat } from "../types.ts";
import {
  ESTIMATED_NOT_PROVEN,
  FLOOR_CONFIDENT,
  METHOD_LABEL,
  type ClaimStrength,
  type NaiveReadout,
  type ReadoutRow,
  type Summary,
} from "./types.ts";

// --- number formatting -----------------------------------------------------

/** Signed delta in a metric's native units, e.g. +$120K / +6.3pp / +4.1K. */
export function formatDelta(value: number, format: MetricFormat): string {
  switch (format) {
    case "currency":
      return formatCurrencyDelta(value);
    case "percent":
      return formatPpDelta(value);
    case "count":
      return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatCount(Math.abs(value))}`;
  }
}

/** "95% CI +$80K to +$160K", or null when either bound is missing. */
function formatCi(low: number | null, high: number | null, format: MetricFormat): string | null {
  if (low === null || high === null) return null;
  return `95% CI ${formatDelta(low, format)} to ${formatDelta(high, format)}`;
}

function sign(v: number | null | undefined): -1 | 0 | 1 {
  if (v === null || v === undefined || v === 0) return 0;
  return v > 0 ? 1 : -1;
}

/** True when a descriptive interval excludes 0 (both bounds same nonzero sign). */
function naiveExcludesZero(naive: NaiveReadout): boolean {
  return sign(naive.ciLow) !== 0 && sign(naive.ciLow) === sign(naive.ciHigh);
}

function riseWord(s: -1 | 0 | 1): string {
  return s > 0 ? "rose" : s < 0 ? "fell" : "moved";
}

function actionLabel(row: ReadoutRow): string {
  const { pr, title } = row.action;
  return pr ? `#${pr} (${title})` : title;
}

// --- claim strength (projection DOWN only) ---------------------------------

/** Resolve how strong a claim the numbers honestly support. This is the ONLY
 *  place strength is decided; it reads belief.score and clamps against the floor,
 *  never reading the naive method (which can never upgrade a verdict). */
export function resolveStrength(row: ReadoutRow): ClaimStrength {
  const { its, belief } = row;
  const belowFloor = Math.min(its.nPre, its.nPost) < FLOOR_CONFIDENT;

  // Explicitly "gathering data": fittable but below the confident floor.
  if (its.status === "INSUFFICIENT_HISTORY" || belief.reason === "INSUFFICIENT_HISTORY") {
    return "gathering-data";
  }
  // Not evaluable at all: too few points to fit, or an unusable fit.
  if (its.status === "INSUFFICIENT" || its.status === "DEGENERATE" || belief.reason === "DEGENERATE") {
    return "unknown";
  }
  // A confident, directional edge — but a 1.0 is only honest above the floor.
  // Defensive clamp: if handed a 1.0 below the floor, withhold it as gathering-data.
  if (belief.score === 1.0 && (belief.direction === "POSITIVE" || belief.direction === "NEGATIVE")) {
    return belowFloor ? "gathering-data" : "confident";
  }
  if (belief.score === 0.0) return "no-effect";
  if (belief.score === 0.5) return "tentative";
  if (belief.score === null) return belowFloor ? "gathering-data" : "unknown";
  return "tentative";
}

// --- descriptive cross-check line ------------------------------------------

/** The always-honest descriptive line. Marks the 14-day method DESCRIPTIVE and
 *  never claims it is more reliable than the ITS, even when its CI is tighter. */
function descriptiveLine(row: ReadoutRow): string {
  const { naive, metric } = row;
  if (naive.lift === null || naive.status !== "OK") {
    return "The 14-day before/after cross-check (descriptive, not causal) could not be computed for this window.";
  }
  const ci = formatCi(naive.ciLow, naive.ciHigh, metric.format);
  const ciPart = ci ? ` (${ci})` : "";
  return (
    `A simple 14-day before/after average shows ${formatDelta(naive.lift, metric.format)}${ciPart}. ` +
    `This is a DESCRIPTIVE cross-check, not a causal estimate — a tighter interval here does NOT make it more trustworthy than the ${METHOD_LABEL} above.`
  );
}

// --- caveat ----------------------------------------------------------------

function baseCaveat(): string {
  return (
    `${METHOD_LABEL} is observational, not a randomized test: it assumes no other change hit ` +
    `this metric at the same time, and its interval is autocorrelation-adjusted. A confident ` +
    `claim needs at least ${FLOOR_CONFIDENT} days of history on each side of the ship date.`
  );
}

const WIDENED_CAVEAT_SUFFIX =
  " The descriptive 14-day check disagrees with the ITS estimate, so treat this impact as especially uncertain.";

// --- the deterministic core ------------------------------------------------

/** Generate an honest summary from a readout row. Pure, deterministic, no LLM. */
export function generateSummary(row: ReadoutRow): Summary {
  const { its, naive, belief, metric } = row;
  const strength = resolveStrength(row);
  const gatheringData = strength === "gathering-data";
  const action = actionLabel(row);
  const shipped = formatLongDate(row.action.shippedAt);

  const itsSign = sign(its.lift);
  const naiveSign = sign(naive.lift);
  const directionalDisagreement = itsSign !== 0 && naiveSign !== 0 && itsSign !== naiveSign;
  // The descriptive check "overstates" when it shows a clear effect the ITS did
  // not confirm as confident — surfacing it uncritically would over-trust the naive CI.
  const naiveOverstates = naiveExcludesZero(naive) && strength !== "confident" && naiveSign !== 0;
  const disagreement = directionalDisagreement || naiveOverstates;

  let caveat = baseCaveat();
  if (disagreement) caveat += WIDENED_CAVEAT_SUFFIX;

  const method = METHOD_LABEL;
  const methodLine = `Method: ${METHOD_LABEL} — the authoritative estimate.`;
  const detail: string[] = [];
  let headline: string;

  switch (strength) {
    case "confident": {
      const rose = riseWord(itsSign);
      const good = its.direction === "POSITIVE" ? metric.higherIsBetter : !metric.higherIsBetter;
      const outcome = good ? "a positive outcome" : "an adverse outcome";
      const lift = its.lift !== null ? formatDelta(its.lift, metric.format) : "";
      headline =
        `${ESTIMATED_NOT_PROVEN}: after shipping ${action}, ${metric.name} ${rose} by ${lift} ` +
        `(${outcome}).`;
      detail.push(methodLine);
      const ci = formatCi(its.ciLow, its.ciHigh, metric.format);
      if (ci) detail.push(`The estimated step is ${lift} (${ci}); this interval excludes zero.`);
      detail.push(`Ship date: ${shipped}. History: ${its.nPre} days before / ${its.nPost} after.`);
      detail.push(descriptiveLine(row));
      break;
    }
    case "tentative": {
      let why: string;
      if (belief.reason === "AUTOCORRELATION") {
        why = "the series is too autocorrelated for the estimate to be trusted at this length";
      } else if (belief.reason === "FDR_DEMOTED") {
        why = "after correcting for testing many shipped actions against this metric, the effect is not significant";
      } else if (belief.reason === "PLACEBO") {
        why = "a pre-ship falsification check flagged the fit as chasing spurious structure";
      } else {
        why = "the confidence interval still includes zero (within the margin of error)";
      }
      const lift = its.lift !== null ? ` (~${formatDelta(its.lift, metric.format)})` : "";
      headline =
        `${ESTIMATED_NOT_PROVEN}, and not yet distinguishable from noise: a possible move in ` +
        `${metric.name}${lift} after shipping ${action}, but ${why}.`;
      detail.push(methodLine);
      const ci = formatCi(its.ciLow, its.ciHigh, metric.format);
      if (ci) detail.push(`Estimated step ${its.lift !== null ? formatDelta(its.lift, metric.format) : "—"} (${ci}).`);
      detail.push(descriptiveLine(row));
      break;
    }
    case "no-effect": {
      const because =
        belief.reason === "PLACEBO"
          ? " A pre-ship falsification check fired, so the apparent move is spurious."
          : its.status === "CONFOUNDED"
          ? " Other changes shipped inside the same window, so no single action can be credited."
          : "";
      headline = `No credible effect: shipping ${action} did not measurably move ${metric.name}.${because}`;
      detail.push(methodLine);
      detail.push(descriptiveLine(row));
      break;
    }
    case "gathering-data": {
      headline =
        `Gathering data: not enough history around the ship date to make a causal claim about ` +
        `${metric.name} yet.`;
      detail.push(
        `${its.nPre} day(s) before / ${its.nPost} after ${shipped}; a confident claim needs at least ` +
          `${FLOOR_CONFIDENT} on each side.`,
      );
      detail.push(methodLine);
      detail.push(descriptiveLine(row));
      break;
    }
    case "unknown": {
      headline =
        `Not evaluable: the series around this ship date can't support a reliable estimate of the ` +
        `effect on ${metric.name}.`;
      detail.push(methodLine);
      detail.push(descriptiveLine(row));
      break;
    }
  }

  return { headline, detail, caveat, method, claimStrength: strength, gatheringData, disagreement };
}
