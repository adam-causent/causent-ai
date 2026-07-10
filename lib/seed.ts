import type {
  Action,
  ImpactCell,
  ImpactStat,
  Metric,
  MetricImpact,
  Observation,
  ProjectObjective,
  Report,
  Scope,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Demo dataset for the v1 UI. Everything here is deterministic: the same values
// are produced on the server and the client, so there is no hydration mismatch.
// This module is the single seam to replace with RLS-scoped Supabase reads later
// (the component tree only ever sees the exported shapes, never Math.random()).
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — no Math.random, so SSR === CSR. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;
const END_DATE = "2025-05-23";
const SERIES_DAYS = 210;

function isoDaysBefore(endISO: string, back: number): string {
  const [y, m, d] = endISO.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) - back * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** Ascending ISO date axis ending at END_DATE. */
const DATES: string[] = Array.from({ length: SERIES_DAYS }, (_, i) =>
  isoDaysBefore(END_DATE, SERIES_DAYS - 1 - i),
);

type Step = { date: string; delta: number };

/**
 * Build an organic-looking daily series from `start` to `end` with light noise
 * and optional step-changes at action ship dates (so the ITS story is visible).
 */
function genSeries(
  seed: number,
  start: number,
  end: number,
  noiseFrac: number,
  steps: Step[] = [],
): Observation[] {
  const rand = mulberry32(seed);
  const range = end - start || Math.abs(end) || 1;
  const stepByIndex = new Map<number, number>();
  for (const s of steps) {
    const idx = DATES.indexOf(s.date);
    if (idx >= 0) stepByIndex.set(idx, (stepByIndex.get(idx) ?? 0) + s.delta);
  }
  let stepAccum = 0;
  let wander = 0;
  return DATES.map((date, i) => {
    stepAccum += stepByIndex.get(i) ?? 0;
    const base = start + (end - start - sumSteps(steps)) * (i / (SERIES_DAYS - 1));
    wander += (rand() - 0.5) * noiseFrac * range * 0.35;
    wander *= 0.9; // mean-reverting so it never runs away
    const value = base + stepAccum + wander + (rand() - 0.5) * noiseFrac * range;
    return { date, value: Math.max(0, value) };
  });
}

function sumSteps(steps: Step[]): number {
  return steps.reduce((a, s) => a + s.delta, 0);
}

// --- Scope ------------------------------------------------------------------

export const scope: Scope = {
  org: "Causent",
  project: "Orbit",
  workspace: "Gummy Alpha",
};

// --- Project objective (the "why" every action rolls up to) ------------------

export const projectObjective: ProjectObjective = {
  title: "North Star",
  statement:
    "Reach $3M ARR by lifting activation and defending against churn — without eroding gross margin. Every action below is a bet toward that goal, and Causent reads out which bets actually moved it.",
  keyResults: [
    "Activation Rate: 33% → 45%",
    "Net ARR: +$500K from shipped experiments",
    "Churn Rate: held under 2.5%",
  ],
  updatedAt: "2025-05-12",
};

// --- Metric series colors (brand-safe, distinguishable) ---------------------

const COLORS = {
  arr: "#00A29C", // teal
  activation: "#377DED", // blue
  churn: "#E5484D", // red
  grossProfit: "#F0B73E", // amber
  support: "#8B5CF6", // purple
} as const;

// --- Actions (shipped merged PRs) -------------------------------------------

/** Helper to build one impact cell with consistent, honest semantics. */
function cell(
  metricId: string,
  direction: ImpactCell["direction"],
  label: string,
  good: boolean,
  value: number | null = null,
): ImpactCell {
  return { metricId, direction, label, good, value };
}

const NONE = (metricId: string): ImpactCell =>
  cell(metricId, "neutral", "—", true, null);

export const actions: Action[] = [
  {
    id: "a-8421",
    pr: 8421,
    title: "Pricing Experiment v2",
    shippedAt: "2025-05-23",
    primaryMetricId: "arr",
    impact: [
      cell("arr", "up", "+$120K", true, 120_000),
      cell("grossProfit", "up", "+$42K", true, 42_000),
      cell("activation", "up", "+3.1pp", true, 3.1),
      cell("churn", "up", "+$8K", false, 8_000),
      NONE("support"),
    ],
    rationale: {
      hypothesis: "Simplifying the pricing page flow will increase paid conversion.",
      expectedMetricId: "activation",
      body: [
        "We observed drop-off on the pricing page, particularly after users selected a plan but before completing checkout. Session replays and quantitative analysis pointed to friction in the plan comparison layout and an excessive number of fields in the payment step.",
        "This change simplifies the plan comparison, highlights the recommended plan, and reduces the required payment fields to only what's essential to get started. We believe this will reduce cognitive load and shorten the path to conversion.",
        "We will monitor Activation Rate (users who start a paid trial or subscription within 7 days of signup) as our primary signal. If successful, we expect a lift within 1–2 weeks of full rollout.",
      ],
    },
  },
  {
    id: "a-8410",
    pr: 8410,
    title: "Onboarding Flow Revamp",
    shippedAt: "2025-05-21",
    primaryMetricId: "activation",
    impact: [
      cell("arr", "up", "+$48K", true, 48_000),
      cell("grossProfit", "up", "+$18K", true, 18_000),
      cell("activation", "up", "+2.4pp", true, 2.4),
      NONE("churn"),
      cell("support", "up", "+$2.1K", false, 2_100),
    ],
  },
  {
    id: "a-8392",
    pr: 8392,
    title: "Paywall Copy Test",
    shippedAt: "2025-05-18",
    primaryMetricId: "arr",
    impact: [
      cell("arr", "up", "+$26K", true, 26_000),
      cell("grossProfit", "up", "+$11K", true, 11_000),
      cell("activation", "up", "+1.2pp", true, 1.2),
      NONE("churn"),
      NONE("support"),
    ],
  },
  {
    id: "a-8383",
    pr: 8383,
    title: "Email Nudge Timing",
    shippedAt: "2025-05-15",
    primaryMetricId: "activation",
    impact: [
      cell("arr", "down", "-$18K", false, -18_000),
      cell("grossProfit", "down", "-$7K", false, -7_000),
      NONE("activation"),
      cell("churn", "up", "+$6K", false, 6_000),
      NONE("support"),
    ],
  },
  {
    id: "a-8367",
    pr: 8367,
    title: "Support Deflection v1",
    shippedAt: "2025-05-13",
    primaryMetricId: "support",
    impact: [
      NONE("arr"),
      NONE("grossProfit"),
      NONE("activation"),
      NONE("churn"),
      cell("support", "down", "-$3.2K", true, -3_200),
    ],
  },
  {
    id: "a-8351",
    pr: 8351,
    title: "Plan Selector UX",
    shippedAt: "2025-05-10",
    primaryMetricId: "arr",
    impact: [
      cell("arr", "up", "+$33K", true, 33_000),
      cell("grossProfit", "up", "+$14K", true, 14_000),
      cell("activation", "up", "+1.8pp", true, 1.8),
      cell("churn", "down", "-$4K", true, -4_000),
      NONE("support"),
    ],
  },
  {
    id: "a-8338",
    pr: 8338,
    title: "Annual Discount Test",
    shippedAt: "2025-05-08",
    primaryMetricId: "arr",
    impact: [
      cell("arr", "down", "-$27K", false, -27_000),
      cell("grossProfit", "down", "-$12K", false, -12_000),
      NONE("activation"),
      cell("churn", "up", "+$7K", false, 7_000),
      NONE("support"),
    ],
  },
  {
    id: "a-8324",
    pr: 8324,
    title: "In-App Guidance",
    shippedAt: "2025-05-06",
    primaryMetricId: "activation",
    impact: [
      cell("arr", "up", "+$22K", true, 22_000),
      cell("grossProfit", "up", "+$9K", true, 9_000),
      cell("activation", "up", "+1.0pp", true, 1.0),
      NONE("churn"),
      cell("support", "down", "-0.9K", true, -900),
    ],
  },
];

/** Step-change bumps applied to a metric's series at each action's ship date. */
function stepsFor(metricId: string): Step[] {
  const steps: Step[] = [];
  for (const a of actions) {
    const c = a.impact.find((x) => x.metricId === metricId);
    if (!c || c.value === null || c.direction === "neutral") continue;
    steps.push({ date: a.shippedAt, delta: c.value });
  }
  return steps;
}

// --- Metrics ----------------------------------------------------------------

export const metrics: Metric[] = [
  {
    id: "arr",
    name: "ARR",
    color: COLORS.arr,
    format: "currency",
    source: "CSV",
    cadence: "Daily",
    lastUpdated: "2025-05-12T10:24:00Z",
    rows: 1826,
    higherIsBetter: true,
    series: genSeries(101, 1_960_000, 2_420_000, 0.02, stepsFor("arr")),
  },
  {
    id: "activation",
    name: "Activation Rate",
    color: COLORS.activation,
    format: "percent",
    source: "CSV",
    cadence: "Daily",
    lastUpdated: "2025-05-12T10:18:00Z",
    rows: 1826,
    higherIsBetter: true,
    series: genSeries(202, 33.0, 41.3, 0.03, [
      { date: "2025-05-06", delta: 1.0 },
      { date: "2025-05-10", delta: 1.8 },
      { date: "2025-05-18", delta: 1.2 },
      { date: "2025-05-21", delta: 2.4 },
      { date: "2025-05-23", delta: 3.1 },
    ]),
  },
  {
    id: "churn",
    name: "Churn Rate",
    color: COLORS.churn,
    format: "percent",
    source: "CSV",
    cadence: "Daily",
    lastUpdated: "2025-05-12T10:21:00Z",
    rows: 1826,
    higherIsBetter: false,
    series: genSeries(303, 3.35, 2.48, 0.04, [
      { date: "2025-05-10", delta: -0.12 },
    ]),
  },
  {
    id: "grossProfit",
    name: "Gross Profit",
    color: COLORS.grossProfit,
    format: "currency",
    source: "CSV",
    cadence: "Daily",
    lastUpdated: "2025-05-12T10:20:00Z",
    rows: 1826,
    higherIsBetter: true,
    series: genSeries(404, 960_000, 1_120_000, 0.02, stepsFor("grossProfit")),
  },
  {
    id: "support",
    name: "Support Tickets",
    color: COLORS.support,
    format: "count",
    source: "CSV",
    cadence: "Daily",
    lastUpdated: "2025-05-12T10:16:00Z",
    rows: 1826,
    higherIsBetter: false,
    series: genSeries(505, 11_200, 8_700, 0.05, [
      { date: "2025-05-13", delta: -1_800 },
    ]),
  },
];

export function metricById(id: string): Metric | undefined {
  return metrics.find((m) => m.id === id);
}

// --- Impact tab aggregates (canonical figures from the approved mockup) ------

// The Aggregated-Impact strip now leads with framing numbers (metric count +
// improvement rate) and then decomposes total impact into its top contributing
// metrics (see components/impact/AggregatedImpact). Only the improvement-rate
// figure is read from here; the metric tiles come from `impactByMetric`.
export const aggregatedImpact: ImpactStat[] = [
  { label: "Improvement Rate", value: "72%", comparison: "vs 55% prior", change: "+17pp", tone: "positive" },
  { label: "Total Actions Shipped", value: "18", comparison: "vs 11", change: "+64%", tone: "positive" },
  { label: "Metrics Improved", value: "4 / 5", comparison: "vs 3 / 5", tone: "positive" },
];

export const impactByMetric: MetricImpact[] = [
  { metricId: "arr", value: 212_000, label: "+$212K", direction: "up", good: true },
  { metricId: "grossProfit", value: 81_000, label: "+$81K", direction: "up", good: true },
  { metricId: "activation", value: 63_000, label: "+6.3pp", direction: "up", good: true },
  { metricId: "churn", value: -24_000, label: "-$24K", direction: "down", good: false },
  { metricId: "support", value: -4_100, label: "-$4.1K", direction: "down", good: false },
];

/** Window for the Impact tab: last 30 days vs prior 30 days. */
export const impactWindow = { start: "2025-04-24", end: "2025-05-23" } as const;

// --- Saved stakeholder reports ----------------------------------------------

export const reports: Report[] = [
  {
    id: "r-2205",
    title: "Q2 Stakeholder Update",
    createdAt: "2025-05-22",
    author: "Adam K.",
    depth: "full",
    summary:
      "Full-quarter rollup: objective progress, every shipped decision, and the confident causal impact behind Orbit's ARR movement.",
  },
  {
    id: "r-2105",
    title: "May Ship Review",
    createdAt: "2025-05-15",
    author: "Adam K.",
    depth: "succinct",
    summary:
      "Succinct readout of May's ships — top movers and the metrics still gathering data toward a confident claim.",
  },
];
