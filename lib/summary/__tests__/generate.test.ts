// Unit tests for the honest-summary layer. Focus: the HARD trust rules
// (eng-review decision #5) — the summary never upgrades or invents a causal claim.
// Run: `node --test lib/summary`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ESTIMATED_NOT_PROVEN,
  FLOOR_CONFIDENT,
  METHOD_LABEL,
  generateSummary,
  resolveStrength,
  formatDelta,
  generateSummaryWithPolish,
  enforceInvariants,
  noopPolisher,
  type ReadoutRow,
  type Summary,
  type SummaryPolisher,
} from "../index.ts";

// --- fixtures --------------------------------------------------------------

/** A confident, above-floor, positive readout. Override per test. */
function baseRow(over: Partial<ReadoutRow> = {}): ReadoutRow {
  const row: ReadoutRow = {
    action: { pr: 8421, title: "New onboarding flow", shippedAt: "2025-03-01" },
    metric: { name: "Activation rate", format: "percent", higherIsBetter: true },
    its: {
      status: "OK",
      lift: 6.3,
      ciLow: 3.1,
      ciHigh: 9.5,
      direction: "POSITIVE",
      nPre: 60,
      nPost: 60,
      pValue: 0.002,
      durbinWatson: 1.9,
    },
    naive: { status: "OK", lift: 5.8, ciLow: 2.0, ciHigh: 9.6 },
    belief: { score: 1.0, direction: "POSITIVE", reason: null },
  };
  return {
    ...row,
    ...over,
    action: { ...row.action, ...over.action },
    metric: { ...row.metric, ...over.metric },
    its: { ...row.its, ...over.its },
    naive: { ...row.naive, ...over.naive },
    belief: { ...row.belief, ...over.belief },
  };
}

const lower = (s: Summary) => (s.headline + " " + s.detail.join(" ") + " " + s.caveat).toLowerCase();

// --- Rule: the method is ALWAYS named (OLS ITS) ----------------------------

test("every summary names the OLS ITS method and never omits it", () => {
  const strengths: Array<Partial<ReadoutRow>> = [
    {}, // confident
    { belief: { score: 0.5, direction: "INCONCLUSIVE", reason: null } }, // tentative
    { belief: { score: 0.0, direction: "INCONCLUSIVE", reason: "PLACEBO" } }, // no-effect
    { its: { ...baseRow().its, status: "INSUFFICIENT_HISTORY" }, belief: { score: null, direction: "INCONCLUSIVE", reason: "INSUFFICIENT_HISTORY" } },
    { its: { ...baseRow().its, status: "DEGENERATE" }, belief: { score: null, direction: "INCONCLUSIVE", reason: "DEGENERATE" } },
  ];
  for (const over of strengths) {
    const s = generateSummary(baseRow(over));
    assert.equal(s.method, METHOD_LABEL);
    assert.ok(s.detail.some((d) => d.includes(METHOD_LABEL)), `method missing for ${JSON.stringify(over)}`);
  }
});

// --- Rule: directional estimates LEAD with "estimated impact, not proven" ---

test("a confident readout leads with 'Estimated impact, not proven' — never 'proven'", () => {
  const s = generateSummary(baseRow());
  assert.equal(s.claimStrength, "confident");
  assert.ok(s.headline.startsWith(ESTIMATED_NOT_PROVEN), s.headline);
  // The only "proven" in the headline is inside "not proven".
  assert.equal(s.headline.toLowerCase().includes("not proven"), true);
});

test("a tentative readout still leads with the estimated/not-proven caveat", () => {
  const s = generateSummary(baseRow({ belief: { score: 0.5, direction: "INCONCLUSIVE", reason: null } }));
  assert.equal(s.claimStrength, "tentative");
  assert.ok(s.headline.startsWith(ESTIMATED_NOT_PROVEN), s.headline);
  assert.ok(/noise|margin of error|not yet distinguishable/i.test(s.headline));
});

// --- Rule: below the 45/45 floor -> "gathering data", no claim --------------

test("INSUFFICIENT_HISTORY resolves to gathering-data with no causal claim", () => {
  const s = generateSummary(
    baseRow({
      its: { ...baseRow().its, status: "INSUFFICIENT_HISTORY", nPre: 20, nPost: 20 },
      belief: { score: null, direction: "INCONCLUSIVE", reason: "INSUFFICIENT_HISTORY" },
    }),
  );
  assert.equal(s.claimStrength, "gathering-data");
  assert.equal(s.gatheringData, true);
  assert.ok(/gathering data/i.test(s.headline));
  assert.ok(s.detail.some((d) => d.includes(String(FLOOR_CONFIDENT))));
});

test("below-floor n on EITHER side alone triggers gathering-data", () => {
  // Post side above floor, pre side below — still gathering.
  assert.equal(
    resolveStrength(baseRow({ its: { ...baseRow().its, nPre: 30, nPost: 90 }, belief: { score: null, direction: "INCONCLUSIVE", reason: "INSUFFICIENT_HISTORY" } })),
    "gathering-data",
  );
});

// --- Rule: NEVER upgrades / invents a claim (defensive floor clamp) ----------

test("a belief 1.0 handed in BELOW the floor is defensively downgraded to gathering-data", () => {
  const s = generateSummary(
    baseRow({
      its: { ...baseRow().its, nPre: 30, nPost: 60 }, // pre side under 45
      belief: { score: 1.0, direction: "POSITIVE", reason: null },
    }),
  );
  assert.notEqual(s.claimStrength, "confident");
  assert.equal(s.claimStrength, "gathering-data");
});

test("the naive method NEVER upgrades a tentative ITS to confident", () => {
  // ITS only tentative (CI includes 0), but the descriptive check looks strong.
  const s = generateSummary(
    baseRow({
      its: { ...baseRow().its, lift: 1.0, ciLow: -0.5, ciHigh: 2.5, direction: "INCONCLUSIVE", durbinWatson: 1.9 },
      naive: { status: "OK", lift: 7.0, ciLow: 5.0, ciHigh: 9.0 }, // tight, excludes 0
      belief: { score: 0.5, direction: "INCONCLUSIVE", reason: null },
    }),
  );
  assert.equal(s.claimStrength, "tentative");
});

// --- Rule: naive is marked DESCRIPTIVE and never "more trustworthy" ----------

test("the descriptive cross-check is labelled descriptive and denied superior trust", () => {
  const s = generateSummary(baseRow());
  const naiveLine = s.detail.find((d) => d.toLowerCase().includes("14-day"));
  assert.ok(naiveLine, "descriptive line present");
  assert.ok(/descriptive/i.test(naiveLine!));
  assert.ok(/not.*more trustworthy/i.test(naiveLine!), naiveLine);
  // Never makes the AFFIRMATIVE claim that the naive method is superior. (The honest
  // "does NOT make it more trustworthy" negation is expected and must not trip this.)
  assert.equal(/more reliable than|descriptive.*is (the )?authoritative/i.test(lower(s)), false);
});

// --- Rule: naive tighter CI is not presented as more trustworthy -> widen ----

test("a tight naive CI over a tentative ITS widens the caveat, not the claim", () => {
  const s = generateSummary(
    baseRow({
      its: { ...baseRow().its, lift: 1.0, ciLow: -1.0, ciHigh: 3.0, direction: "INCONCLUSIVE" },
      naive: { status: "OK", lift: 6.0, ciLow: 5.0, ciHigh: 7.0 }, // tighter, excludes 0
      belief: { score: 0.5, direction: "INCONCLUSIVE", reason: null },
    }),
  );
  assert.equal(s.claimStrength, "tentative");
  assert.equal(s.disagreement, true);
  assert.ok(/especially uncertain/i.test(s.caveat));
});

// --- Rule: on ITS-vs-naive DISAGREEMENT, widen the caveat --------------------

test("opposite-sign ITS and naive lifts flag disagreement and widen the caveat", () => {
  const s = generateSummary(
    baseRow({
      its: { ...baseRow().its, lift: 4.0, ciLow: 1.0, ciHigh: 7.0, direction: "POSITIVE" },
      naive: { status: "OK", lift: -3.0, ciLow: -6.0, ciHigh: -0.5 }, // opposite direction
    }),
  );
  assert.equal(s.disagreement, true);
  assert.ok(/disagrees|especially uncertain/i.test(s.caveat));
});

test("agreeing ITS and naive do NOT widen the caveat", () => {
  const s = generateSummary(baseRow()); // both positive, ITS confident
  assert.equal(s.disagreement, false);
  assert.equal(/especially uncertain/i.test(s.caveat), false);
});

// --- no-effect (0.0) branches ----------------------------------------------

test("belief 0.0 with a fired placebo reads as no credible effect", () => {
  const s = generateSummary(
    baseRow({ belief: { score: 0.0, direction: "INCONCLUSIVE", reason: "PLACEBO" } }),
  );
  assert.equal(s.claimStrength, "no-effect");
  assert.ok(/no credible effect/i.test(s.headline));
  assert.ok(/falsification|spurious/i.test(s.headline));
});

test("a CONFOUNDED readout attributes the miss to co-temporal changes", () => {
  const s = generateSummary(
    baseRow({
      its: { ...baseRow().its, status: "CONFOUNDED" },
      belief: { score: 0.0, direction: "INCONCLUSIVE", reason: null },
    }),
  );
  assert.equal(s.claimStrength, "no-effect");
  assert.ok(/other changes|same window/i.test(s.headline));
});

// --- unknown branches -------------------------------------------------------

test("a DEGENERATE fit is 'not evaluable', not zero and not a claim", () => {
  const s = generateSummary(
    baseRow({
      its: { ...baseRow().its, status: "DEGENERATE", lift: null, ciLow: null, ciHigh: null },
      belief: { score: null, direction: "INCONCLUSIVE", reason: "DEGENERATE" },
    }),
  );
  assert.equal(s.claimStrength, "unknown");
  assert.ok(/not evaluable/i.test(s.headline));
});

test("INSUFFICIENT (too few points to fit) is unknown, not gathering-data", () => {
  assert.equal(
    resolveStrength(
      baseRow({
        its: { ...baseRow().its, status: "INSUFFICIENT", nPre: 5, nPost: 5 },
        belief: { score: null, direction: "INCONCLUSIVE", reason: null },
      }),
    ),
    "unknown",
  );
});

// --- tentative reason wording ----------------------------------------------

test("AUTOCORRELATION and FDR_DEMOTED tentatives explain themselves distinctly", () => {
  const auto = generateSummary(
    baseRow({ belief: { score: 0.5, direction: "INCONCLUSIVE", reason: "AUTOCORRELATION" } }),
  );
  assert.ok(/autocorrelated/i.test(auto.headline));

  const fdr = generateSummary(
    baseRow({ belief: { score: 0.5, direction: "INCONCLUSIVE", reason: "FDR_DEMOTED" } }),
  );
  assert.ok(/many shipped actions|not significant/i.test(fdr.headline));
});

// --- direction / good-bad framing (inverted metrics) ------------------------

test("a NEGATIVE effect on an inverted metric reads as a positive outcome", () => {
  const s = generateSummary(
    baseRow({
      metric: { name: "Monthly churn", format: "percent", higherIsBetter: false },
      its: { ...baseRow().its, lift: -1.2, ciLow: -2.0, ciHigh: -0.4, direction: "NEGATIVE" },
      naive: { status: "OK", lift: -1.0, ciLow: -1.9, ciHigh: -0.1 },
      belief: { score: 1.0, direction: "NEGATIVE", reason: null },
    }),
  );
  assert.equal(s.claimStrength, "confident");
  assert.ok(/positive outcome/i.test(s.headline), s.headline);
  assert.ok(/fell/i.test(s.headline));
});

// --- formatDelta ------------------------------------------------------------

test("formatDelta renders signed native-unit deltas per metric format", () => {
  assert.equal(formatDelta(120000, "currency"), "+$120K");
  assert.equal(formatDelta(-4100, "currency"), "-$4.1K");
  assert.equal(formatDelta(6.3, "percent"), "+6.3pp");
  assert.equal(formatDelta(-2.5, "percent"), "-2.5pp");
  assert.equal(formatDelta(4100, "count"), "+4.1K");
});

// --- polish seam: OFF by default, invariant-clamped -------------------------

test("the noop polisher yields a verdict identical to the deterministic core", async () => {
  const row = baseRow();
  const core = generateSummary(row);
  const polished = await generateSummaryWithPolish(row); // default = noopPolisher
  assert.deepEqual(polished, core);
  assert.deepEqual(await generateSummaryWithPolish(row, noopPolisher), core);
});

test("an adversarial polisher can NEVER upgrade or invent a claim", async () => {
  const row = baseRow({ belief: { score: 0.5, direction: "INCONCLUSIVE", reason: null } });
  const draft = generateSummary(row);
  assert.equal(draft.claimStrength, "tentative");

  // A rogue model tries to fabricate certainty and strip the honest lead.
  const rogue: SummaryPolisher = {
    async polish() {
      return {
        headline: "PROVEN: this shipped change caused a massive, guaranteed win.",
        detail: ["Trust me."],
        caveat: "No caveats.",
        method: "Magic",
        claimStrength: "confident",
        gatheringData: false,
        disagreement: false,
      };
    },
  };
  const clamped = await generateSummaryWithPolish(row, rogue);

  // Verdict, method, caveat and floor state are all re-asserted from the core.
  assert.equal(clamped.claimStrength, "tentative");
  assert.equal(clamped.method, METHOD_LABEL);
  assert.equal(clamped.caveat, draft.caveat);
  assert.equal(clamped.gatheringData, draft.gatheringData);
  // A directional headline that lost the honest lead is reverted to the core.
  assert.equal(clamped.headline, draft.headline);
  assert.equal(/^proven/i.test(clamped.headline), false);
});

test("enforceInvariants keeps polished prose when it preserves the honest lead", () => {
  const draft = generateSummary(baseRow()); // confident
  const polished: Summary = {
    ...draft,
    headline: `${ESTIMATED_NOT_PROVEN}: onboarding likely lifted activation — see the ITS estimate.`,
    detail: ["Rephrased but honest."],
    // A rogue attempt to upgrade the verdict is still clamped:
    claimStrength: "confident",
  };
  const out = enforceInvariants(draft, polished);
  assert.equal(out.headline, polished.headline); // kept: lead preserved
  assert.deepEqual(out.detail, ["Rephrased but honest."]);
  assert.equal(out.claimStrength, draft.claimStrength);
  assert.equal(out.method, METHOD_LABEL);
});
