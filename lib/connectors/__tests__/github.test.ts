// Pure unit tests for the GitHub connector core (#16). Zero credentials, zero
// DB, zero network — the deep-link builder, provenance mint/match, the canonical
// map, and HMAC verification. Run: `node --test lib/connectors`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  buildIssueDeepLink,
  canonicalTransition,
  decisionIdFromToken,
  findProvenance,
  issueExternalRef,
  parseIssueEvent,
  provenanceToken,
  verifyWebhookSignature,
} from "../github.ts";

const DECISION = "11111111-2222-3333-4444-555555555555";

// --- deep-link builder --------------------------------------------------------
test("deep-link builder: prefilled issues/new URL with title, body token, label", () => {
  const url = buildIssueDeepLink({
    owner: "acme",
    repo: "orbit",
    title: "Ship the new onboarding checklist",
    body: "Add a 3-step checklist to first-run.",
    decisionId: DECISION,
  });
  assert.ok(url.startsWith("https://github.com/acme/orbit/issues/new?"));
  const qs = new URL(url).searchParams;
  assert.equal(qs.get("title"), "Ship the new onboarding checklist");
  assert.equal(qs.get("labels"), `causent-decision-${DECISION}`);
  // the body carries the provenance token too (strategy-2 marker, survives a
  // stripped label).
  assert.match(qs.get("body") ?? "", /causent-decision-11111111/);
  assert.match(qs.get("body") ?? "", /Add a 3-step checklist/);
});

// --- provenance token mint / match -------------------------------------------
test("provenance token: mint round-trips and matches by label then body", () => {
  const token = provenanceToken(DECISION);
  assert.equal(token, `causent-decision-${DECISION}`);
  assert.equal(decisionIdFromToken(token), DECISION);
  assert.equal(decisionIdFromToken("not-a-token"), null);

  // strategy 1 — the label
  const byLabel = findProvenance([`causent-decision-${DECISION}`, "bug"], null);
  assert.deepEqual(byLabel, { token, decisionId: DECISION });

  // strategy 2 — the body marker (label stripped)
  const byBody = findProvenance(["bug"], `work item\n<!-- causent-decision-${DECISION} -->`);
  assert.deepEqual(byBody, { token, decisionId: DECISION });

  // neither → null
  assert.equal(findProvenance(["bug"], "no marker here"), null);
});

test("parseIssueEvent: extracts ref + provenance + canonical from a webhook body", () => {
  const parsed = parseIssueEvent({
    action: "opened",
    issue: {
      number: 42,
      html_url: "https://github.com/acme/orbit/issues/42",
      state: "open",
      labels: [{ name: `causent-decision-${DECISION}` }, { name: "enhancement" }],
      body: "the work",
    },
  });
  assert.equal(parsed.decisionId, DECISION);
  assert.equal(parsed.externalRef, issueExternalRef(42));
  assert.equal(parsed.externalRef, "github:issue:42");
  assert.equal(parsed.canonical, "LEVER_ACTIVE");
  assert.equal(parsed.htmlUrl, "https://github.com/acme/orbit/issues/42");
});

// --- canonical-transition map -------------------------------------------------
test("canonical-transition map (GitHub issue action → canonical)", () => {
  assert.equal(canonicalTransition("opened"), "LEVER_ACTIVE");
  assert.equal(canonicalTransition("reopened"), "LEVER_ACTIVE");
  assert.equal(canonicalTransition("closed", "completed"), "LEVER_SHIPPED");
  assert.equal(canonicalTransition("closed", null), "LEVER_SHIPPED");
  assert.equal(canonicalTransition("closed", "not_planned"), "LEVER_DROPPED");
  assert.equal(canonicalTransition("labeled"), null);
  assert.equal(canonicalTransition("assigned"), null);
});

// --- webhook signature verify -------------------------------------------------
test("verifyWebhookSignature: accepts a valid HMAC, rejects tampering/missing", () => {
  const secret = "s3cr3t-test";
  const body = JSON.stringify({ action: "opened", issue: { number: 7 } });
  const good = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

  assert.equal(verifyWebhookSignature(secret, body, good), true);
  assert.equal(verifyWebhookSignature(secret, body, null), false);
  assert.equal(verifyWebhookSignature(secret, body, "sha256=deadbeef"), false);
  assert.equal(verifyWebhookSignature(secret, `${body} `, good), false); // body tampered
  assert.equal(verifyWebhookSignature("wrong-secret", body, good), false);
});
