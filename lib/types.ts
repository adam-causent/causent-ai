// Shared types for the Causent v1 UI. These deliberately mirror the shape of the
// persisted schema (supabase/migrations) so the seed layer can later be swapped for
// RLS-scoped Supabase reads without touching components.

/** org → project → workspace scope hierarchy (see decision-graph.md). */
export type Scope = {
  org: string;
  project: string;
  workspace: string;
};

/** A single day of a metric's time series. `date` is an ISO yyyy-mm-dd string. */
export type Observation = {
  date: string;
  value: number;
};

/** How a metric's value should be rendered. */
export type MetricFormat = "currency" | "percent" | "count";

export type Metric = {
  id: string;
  name: string;
  /** Stable brand-safe series color (hex). */
  color: string;
  format: MetricFormat;
  source: "CSV" | "Postgres" | "BigQuery";
  cadence: "Daily";
  /** ISO timestamp of last ingest. */
  lastUpdated: string;
  rows: number;
  /** Daily observations, ascending by date. */
  series: Observation[];
  /** For a metric, is "up" good? churn/support-tickets are inverted. */
  higherIsBetter: boolean;
};

/**
 * Direction of an effect, triple-encoded downstream (glyph + position + color +
 * label) so it never relies on color alone (colorblind-safe requirement).
 */
export type Direction = "up" | "down" | "neutral";

/** One authoritative readout cell: an action's estimated impact on one metric. */
export type ImpactCell = {
  metricId: string;
  direction: Direction;
  /** Signed magnitude in the metric's native unit. null = no measured effect ("—"). */
  value: number | null;
  /** Pre-formatted display label, e.g. "+$120K", "+3.1pp", "—". */
  label: string;
  /** Whether this cell is a positive business outcome (accounts for inverted metrics). */
  good: boolean;
  /** Causal is authoritative ITS; descriptive is the preliminary 14-day cross-check. */
  evidence?: "causal" | "descriptive";
  /** Honest UI qualifier for preliminary or otherwise non-authoritative readouts. */
  detail?: string;
};

/** A shipped action (v1: a merged GitHub PR). */
export type Action = {
  id: string;
  /** Stable visible coordinate within the decision plan, e.g. D1A1. */
  displayCode?: string;
  /** GitHub PR number, e.g. 8421. */
  pr: number;
  /** Origin and human-readable reference. Optional for legacy seed fixtures. */
  source?: "github" | "jira" | "manual";
  referenceLabel?: string;
  /** Stable Decision Report item id for matching the durable action detail. */
  sourceItemId?: string;
  ownerLabel?: string;
  title: string;
  /** ISO yyyy-mm-dd ship date. null = not yet shipped (an open lever — see VOIDED). */
  shippedAt: string | null;
  /** The metric this action primarily targeted. */
  primaryMetricId: string;
  /** Per-metric authoritative impact cells (ITS row). */
  impact: ImpactCell[];
  /** Rich-text-ish rationale ("Why did we build this?"). Plain paragraphs for v1. */
  rationale?: {
    hypothesis: string;
    expectedMetricId: string;
    body: string[];
  };
  manualCompletion?: {
    completedOn: string;
    explanation: string;
  };
};

export type PredictionDirection = "POSITIVE" | "NEGATIVE";

/** The 9-state resolution verdict machine (docs/designs/prospective-prediction-loop.md).
 *  UNMEASURABLE_NO_METRIC (C1/#14) is the declared-metric-never-wired terminal:
 *  the resolution scorecard renders a connect/self-report prompt for it, never a
 *  blank or error. */
export type PredictionVerdict =
  | "CONFIRMED"
  | "DIRECTION_CONFIRMED"
  | "REFUTED"
  | "INCONCLUSIVE"
  | "GATHERING"
  | "UNRESOLVABLE"
  | "VOIDED"
  | "UNATTRIBUTED"
  | "UNMEASURABLE_NO_METRIC";

/** The subset of the resolution memory tuple the scorecard reads (C5/#18).
 *  Written by engine/persistence/resolve.py; all fields optional because a
 *  GATHERING / UNMEASURABLE_NO_METRIC tuple carries no measured side. */
export type ResolutionTuple = {
  predicted_direction?: string | null;
  predicted_magnitude_pct?: number | null;
  predicted_native?: number | null;
  pre_window_mean?: number | null;
  measured_direction?: string | null;
  measured_lift?: number | null;
  measured_pct?: number | null;
  ci_low?: number | null;
  ci_high?: number | null;
  belief_score?: number | null;
  belief_reason?: string | null;
  verdict?: string | null;
} | null;

/** One logged change to a committed prediction — a revision is data, not a failure. */
export type PredictionRevision = {
  oldMagnitudePct: number;
  newMagnitudePct: number;
  reason: string;
  /** ISO yyyy-mm-dd. */
  revisedAt: string;
};

/** Detector status for baseline drift (mirrors engine causal.types.DriftStatus). */
export type DriftStatus = "FIRED" | "NOT_FIRED" | "NO_BASELINE_YET";

/**
 * Baseline-drift readout for a prediction, computed ON READ by the engine
 * (persistence/drift_read.py) — never persisted. A baseline move is a FACT, not a
 * verdict: `direction` is the metric's movement only. Levels are the plainly-shown
 * before/after segment means; the fire decision rests on the fitted step CI.
 */
export type DriftReadout = {
  status: DriftStatus;
  reason: string | null;
  /** ISO yyyy-mm-dd of the detected change-point; null unless FIRED. */
  shiftDate: string | null;
  /** In-window baseline before/after the shift, native metric units. */
  preLevel: number | null;
  postLevel: number | null;
  deltaNative: number | null;
  /** Signed baseline move relative to |preLevel|, in %. */
  pctChange: number | null;
  direction: "up" | "down" | null;
  ciLow: number | null;
  ciHigh: number | null;
  nPre: number;
  nPost: number;
};

/**
 * A human pre-registered prediction (elicit-not-assert: the TEAM commits this
 * number; the engine only measures it at resolutionDate). Mirrors the
 * `predictions` table.
 */
export type Prediction = {
  id: string;
  metricId: string;
  direction: PredictionDirection;
  /** The committed magnitude, %-of-metric-mean — authoritative for display. */
  magnitudePctMean: number;
  /** ISO yyyy-mm-dd. GATHERING auto-extends this date. */
  resolutionDate: string;
  /** ISO yyyy-mm-dd. */
  committedAt: string;
  /** null = not yet resolved. */
  verdict: PredictionVerdict | null;
  /** ISO yyyy-mm-dd; null until a terminal verdict. */
  resolvedAt: string | null;
  /** Measured %-of-mean from the resolution tuple (display only; null = none). */
  measuredPct: number | null;
  /** The resolution memory tuple (predicted-vs-measured shaping for the
   *  scorecard, C5/#18); null until resolved or when the engine wrote none. */
  resolutionTuple?: ResolutionTuple;
  revisions: PredictionRevision[];
  /**
   * Baseline drift on the predicted metric, computed on read (null = not computed:
   * a resolved prediction, or the engine read was unavailable). The notice renders
   * from this — FIRED shows the calm assert-fact card.
   */
  drift?: DriftReadout | null;
};

/**
 * The intent layer: a decision groups the actions that implement it and owns
 * the predictions committed against it. Mirrors the `decisions` +
 * `decision_actions` tables. NOT a causal-graph participant.
 */
export type Decision = {
  id: string;
  title: string;
  /** Creation path. Optional only for the deterministic legacy seed fixtures. */
  origin?: "decision_report" | "legacy";
  /** ISO yyyy-mm-dd. */
  createdAt: string;
  /** Why — plain paragraphs for v1 (mirrors decisions.rationale). */
  rationale: { body: string[]; mechanismCategory?: string };
  /** Actions grouped under this decision (ids into the actions list). */
  actionIds: string[];
  /** v1 invariant: ONE lever per (decision, metric); null = unmapped (UNATTRIBUTED risk). */
  leverActionId: string | null;
  predictions: Prediction[];
};

/**
 * The project's north-star document: the single purpose every shipped action
 * rolls up to. Rendered above the action list so the "why" frames the "what".
 */
export type ProjectObjective = {
  /** Short eyebrow label, e.g. "North Star". */
  title: string;
  /** The purpose statement — one or two sentences. */
  statement: string;
  /** Measurable results that define success. */
  keyResults: string[];
  /** ISO yyyy-mm-dd of last edit. */
  updatedAt: string;
};

/**
 * A saved stakeholder report: a whole-project rollup of the objective, decisions,
 * key metrics, and impact analysis. Doubles as the summarization that feeds the
 * decision graph. `depth` controls how much the rendered report shows.
 */
export type Report = {
  id: string;
  title: string;
  /** ISO yyyy-mm-dd the report was generated. */
  createdAt: string;
  author: string;
  /** "full" = every action + full analysis; "succinct" = objective + top movers. */
  depth: "full" | "succinct";
  /** One-line description shown in the report list. */
  summary: string;
};

/** One card in the Aggregated Impact strip. */
export type ImpactStat = {
  label: string;
  value: string;
  /** Comparison sublabel, e.g. "vs 11". */
  comparison: string;
  /** Optional signed change chip, e.g. "+64%". */
  change?: string;
  tone: "positive" | "negative" | "neutral" | "plain";
};

/** One row of the Impact-by-Metric diverging bar chart. */
export type MetricImpact = {
  metricId: string;
  /** Position on the $-axis (native magnitude used for bar length). */
  value: number;
  /** Display label, e.g. "+$212K" or "+6.3pp". */
  label: string;
  direction: Direction;
  good: boolean;
};
