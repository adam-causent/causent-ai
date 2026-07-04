// Contracts for the honest-summary layer (Phase B1).
//
// A "readout row" is the UI-facing projection of one engine ActionReadout
// (action x metric): the authoritative OLS Interrupted Time Series result, the
// descriptive 14-day before/after cross-check, and the projected edge belief.
// These shapes mirror engine/causal/types.py + the persisted evidence_objects /
// causal_edges columns so the generator can be fed straight from the bridge.
//
// The generator turns a row into HONEST prose. The single hard rule (eng-review
// decision #5): the summary NEVER upgrades or invents a causal claim. It only
// ever projects the engine's verdict downward — never up — and marks the naive
// method as descriptive, never as more trustworthy than the authoritative ITS.

import type { MetricFormat } from "../types.ts";

/** Per-side day floor to stake a CONFIDENT (belief 1.0) claim. Mirrors the
 *  engine's FLOOR_CONFIDENT (engine/causal/types.py). Below it on EITHER side the
 *  readout is honestly "gathering data" and no confident claim is shown. */
export const FLOOR_CONFIDENT = 45;

/** Human-facing method name — always "OLS Interrupted Time Series". */
export const METHOD_LABEL = "OLS Interrupted Time Series (segmented regression)";

/** The lead every directional estimate opens with — never dropped, never softened. */
export const ESTIMATED_NOT_PROVEN = "Estimated impact, not proven";

/** Effect sign / edge direction (mirrors engine Direction). */
export type BeliefDirection = "POSITIVE" | "NEGATIVE" | "INCONCLUSIVE";

/** Readout status (mirrors engine Status). */
export type ReadoutStatus =
  | "OK"
  | "INSUFFICIENT"
  | "INSUFFICIENT_HISTORY"
  | "DEGENERATE"
  | "CONFOUNDED";

/** Why belief was withheld/demoted (mirrors engine BeliefReason). */
export type BeliefReason =
  | "PLACEBO"
  | "AUTOCORRELATION"
  | "INSUFFICIENT_HISTORY"
  | "DEGENERATE"
  | "FDR_DEMOTED";

/** The authoritative OLS ITS readout for one action x metric. */
export type ItsReadout = {
  status: ReadoutStatus;
  /** Step coefficient in the metric's native units; null unless status === "OK". */
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  direction: BeliefDirection;
  /** Daily observations before / on-or-after the ship date. Drive the 45/45 floor. */
  nPre: number;
  nPost: number;
  pValue: number | null;
  durbinWatson: number | null;
};

/** The DESCRIPTIVE 14-day before/after cross-check. Non-authoritative: it carries
 *  no p-value and NEVER drives the claim, no matter how tight its interval looks. */
export type NaiveReadout = {
  status: ReadoutStatus;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
};

/** The projected edge belief (mirrors engine Belief). score is null | 0 | 0.5 | 1. */
export type Belief = {
  score: number | null;
  direction: BeliefDirection;
  reason: BeliefReason | null;
};

/** Minimal action + metric context the prose needs. */
export type ActionContext = {
  /** GitHub PR number, when the action came from a merged PR. */
  pr?: number;
  title: string;
  /** ISO yyyy-mm-dd ship date. */
  shippedAt: string;
};

export type MetricContext = {
  name: string;
  format: MetricFormat;
  /** For this metric, is "up" a good business outcome? (churn/tickets invert.) */
  higherIsBetter: boolean;
};

/** One action x metric readout row — the generator's sole input. */
export type ReadoutRow = {
  action: ActionContext;
  metric: MetricContext;
  its: ItsReadout;
  naive: NaiveReadout;
  belief: Belief;
};

/** How strong a claim the numbers honestly support. */
export type ClaimStrength =
  | "confident" // belief 1.0, above floor, directional — still "estimated, not proven"
  | "tentative" // belief 0.5 — a signal, not distinguishable from noise
  | "no-effect" // belief 0.0 — no credible effect (placebo-falsified / confounded)
  | "gathering-data" // below the 45/45 floor — withheld, not yet evaluable
  | "unknown"; // unusable fit / too few points to fit at all

/** The generated honest summary. */
export type Summary = {
  /** One-line verdict. Directional claims lead with ESTIMATED_NOT_PROVEN. */
  headline: string;
  /** Supporting sentences (method line, descriptive cross-check, etc.). */
  detail: string[];
  /** The honest caveat; widened when ITS and the descriptive check disagree. */
  caveat: string;
  /** Always the authoritative method name (OLS ITS). */
  method: string;
  claimStrength: ClaimStrength;
  /** True below the 45/45 floor. */
  gatheringData: boolean;
  /** True when the descriptive cross-check contradicts / overstates vs the ITS. */
  disagreement: boolean;
};
