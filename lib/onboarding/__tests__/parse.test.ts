// Unit gate for the pure decision-card layer (C2/#15): the paste guard, the
// strict model-response mapping, and the fallback derivation. No network, no
// DB — the LLM call itself is the fail-safe seam in llm.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FALLBACK_QUESTIONS,
  TITLE_MAX,
  fallbackCard,
  mapCardResponse,
  pasteLooksEmpty,
} from "../parse.ts";

// --- paste guard ---------------------------------------------------------

test("pasteLooksEmpty flags empty, whitespace, and letterless pastes", () => {
  assert.equal(pasteLooksEmpty(""), true);
  assert.equal(pasteLooksEmpty("   \n\t  "), true);
  assert.equal(pasteLooksEmpty("1234567890123456"), true); // digits only
  assert.equal(pasteLooksEmpty("short"), true); // under the floor
  assert.equal(pasteLooksEmpty("Rebuild the signup funnel"), false);
});

// --- model-response mapping ----------------------------------------------

const GOOD = {
  title: "Rebuild the pricing page around usage tiers",
  metric_name: "Expansion revenue",
  mechanism_category: "monetization",
  mechanism_summary: "Usage tiers make upgrades self-serve.",
  questions: ["What exactly changes on the page?", "Why would tiers move expansion?"],
};

test("mapCardResponse maps a well-formed response", () => {
  const card = mapCardResponse(GOOD);
  assert.ok(card);
  assert.equal(card.title, GOOD.title);
  assert.equal(card.metricName, "Expansion revenue");
  assert.equal(card.mechanismCategory, "monetization");
  assert.equal(card.mechanismSummary, GOOD.mechanism_summary);
  assert.deepEqual(card.questions, GOOD.questions);
  assert.equal(card.source, "llm");
});

test("mapCardResponse rejects unusable shapes (caller falls back)", () => {
  assert.equal(mapCardResponse(null), null);
  assert.equal(mapCardResponse("a string"), null);
  assert.equal(mapCardResponse({ ...GOOD, title: "ab" }), null); // too short
  assert.equal(mapCardResponse({ ...GOOD, title: 42 }), null);
  assert.equal(mapCardResponse({ ...GOOD, questions: "not an array" }), null);
});

test("mapCardResponse clamps and pads: title length, question count, enums", () => {
  const long = mapCardResponse({ ...GOOD, title: "x".repeat(300) });
  assert.ok(long);
  assert.equal(long.title.length, TITLE_MAX);
  assert.ok(long.title.endsWith("…"));

  const many = mapCardResponse({ ...GOOD, questions: ["a?", "b?", "c?", "d?", "e?"] });
  assert.ok(many);
  assert.deepEqual(many.questions, ["a?", "b?", "c?"]); // clamped to 3

  const thin = mapCardResponse({ ...GOOD, questions: ["only one?"] });
  assert.ok(thin);
  assert.equal(thin.questions.length, 2); // padded from the fallback set
  assert.equal(thin.questions[0], "only one?");
  assert.ok(FALLBACK_QUESTIONS.includes(thin.questions[1]));

  const oddCat = mapCardResponse({ ...GOOD, mechanism_category: "growth-hacking" });
  assert.ok(oddCat);
  assert.equal(oddCat.mechanismCategory, "other");

  const noMetric = mapCardResponse({ ...GOOD, metric_name: "   " });
  assert.ok(noMetric);
  assert.equal(noMetric.metricName, null); // manual metric entry path
});

// --- fallback derivation ---------------------------------------------------

test("fallbackCard derives title from the first non-empty line", () => {
  const card = fallbackCard("\n\n  Ship the referral program  \nmore context here");
  assert.equal(card.title, "Ship the referral program");
  assert.equal(card.metricName, null); // manual metric entry
  assert.deepEqual(card.questions, FALLBACK_QUESTIONS);
  assert.equal(card.source, "fallback");
});

test("fallbackCard never dead-ends: garbage still yields a workable card", () => {
  const card = fallbackCard("   ");
  assert.equal(card.title, "Untitled decision");
  assert.equal(card.questions.length, 3);

  const longLine = fallbackCard("y".repeat(500));
  assert.equal(longLine.title.length, TITLE_MAX);
});
