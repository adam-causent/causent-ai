import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSafeFallbackReport,
  materializeModelDecisionReport,
  validateModelDecisionReportDraft,
  type ModelClaimDraft,
  type ModelDecisionReportDraft,
} from "./generation-contract.ts";
import {
  DecisionReportGenerationTimeoutError,
  runWithSingleRetry,
} from "./generation-policy.ts";

const PROMPT =
  "Launch an AI helper for checkout. Shoppers abandon checkout. Baseline completion is 40% and the founder prediction is 55%. The product lead is Maya. Cost is $15 per month.";

function claim(
  text: string,
  kind: ModelClaimDraft["kind"] = "suggestion",
  evidenceQuote = "",
): ModelClaimDraft {
  return { text, kind, evidenceQuote };
}

function draft(): ModelDecisionReportDraft {
  return {
    projectName: "Checkout Helper",
    title: "AI guidance for checkout",
    decision: {
      decision: claim(
        "Launch an AI helper for checkout.",
        "supported",
        "Launch an AI helper for checkout.",
      ),
      background: claim("An AI helper is being considered.", "inference"),
      problem: claim(
        "Shoppers abandon checkout.",
        "supported",
        "Shoppers abandon checkout.",
      ),
    },
    supportingEvidence: {
      factors: [claim("Shoppers abandon checkout.", "supported", "Shoppers abandon checkout.")],
      metricMechanism: claim("Guidance may reduce uncertainty.", "inference"),
      alternatives: [claim("Improve static checkout guidance.")],
      precedent: [claim("", "missing")],
    },
    implementation: {
      actionPlanSummary: claim("Instrument, build, and test the helper."),
      actions: [
        {
          title: "Instrument checkout",
          summary: claim("Measure checkout starts and completions."),
          owner: claim("Maya", "supported", "The product lead is Maya."),
        },
      ],
      cost: [claim("$15 per month", "supported", "Cost is $15 per month.")],
      customers: [claim("Enterprise customers", "inference")],
      stakeholders: [claim("Maya", "supported", "The product lead is Maya.")],
      governance: {
        dataClassification: "unspecified",
        allowedDataSources: [claim("", "missing")],
        approvedModelNotes: [claim("", "missing")],
      },
    },
    metric: {
      name: "Checkout completion rate",
      definition: "Completed checkouts divided by checkout starts",
      baselinePct: 40,
      baselineEvidenceQuote: "Baseline completion is 40%",
      predictedPct: 55,
      predictedEvidenceQuote: "the founder prediction is 55%",
    },
  };
}

test("model draft validation rejects malformed structured output", () => {
  const result = validateModelDecisionReportDraft({ title: "Incomplete" });
  assert.equal(result.success, false);
});

test("server materialization assigns IDs and verifies exact prompt evidence", () => {
  let nextId = 0;
  const result = materializeModelDecisionReport(draft(), PROMPT, {
    idFactory: () => String(++nextId),
  });

  assert.equal(result.report.decision.decision[0].status, "sourced");
  assert.deepEqual(result.report.decision.decision[0].sourceChunkIds, ["initial-prompt"]);
  assert.match(result.report.decision.decision[0].id, /^decision-\d+$/);
  assert.equal(result.report.implementation.actions[0].owner?.status, "sourced");
  assert.equal(result.metricProjection.baselinePct, 40);
  assert.equal(result.metricProjection.predictedPct, 55);
});

test("invented metrics, customers, owners, costs, and numeric claims are removed", () => {
  const generated = draft();
  generated.implementation.customers = [claim("Fortune 500 buyers", "inference")];
  generated.implementation.actions[0].owner = claim("Sam", "inference");
  generated.implementation.cost = [claim("$99,000", "supported", "Cost is $15 per month.")];
  generated.metric.baselinePct = 72;
  generated.metric.baselineEvidenceQuote = "Baseline completion is 40%";
  generated.supportingEvidence.metricMechanism = claim("Completion will improve 30%", "inference");

  const result = materializeModelDecisionReport(generated, PROMPT, { idFactory: () => "trusted" });
  assert.equal(result.report.implementation.customers[0].status, "missing");
  assert.equal(result.report.implementation.actions[0].owner, null);
  assert.equal(result.report.implementation.cost[0].status, "missing");
  assert.equal(result.metricProjection.baselinePct, null);
  assert.equal(result.report.supportingEvidence.metricMechanism[0].status, "missing");
});

test("safe fallback preserves the brief and leaves unsupported fields missing", () => {
  const fallback = createSafeFallbackReport(PROMPT, { idFactory: () => "safe" });
  assert.equal(fallback.report.decision.background[0].text, PROMPT);
  assert.equal(fallback.report.decision.background[0].status, "sourced");
  assert.equal(fallback.report.decision.decision[0].status, "missing");
  assert.equal(fallback.metricProjection.evidenceState, "missing");
});

test("generation policy retries exactly once after a refusal", async () => {
  let attempts = 0;
  const result = await runWithSingleRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("provider refusal");
    return "accepted";
  }, 100);

  assert.equal(result.value, "accepted");
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
});

test("generation policy stops after two provider refusals", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithSingleRetry(async () => {
      attempts += 1;
      throw new Error("provider refusal");
    }, 100),
    /provider refusal/,
  );
  assert.equal(attempts, 2);
});

test("generation policy times out and retries once", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithSingleRetry(async () => {
      attempts += 1;
      await new Promise(() => undefined);
      return "never";
    }, 5),
    DecisionReportGenerationTimeoutError,
  );
  assert.equal(attempts, 2);
});
