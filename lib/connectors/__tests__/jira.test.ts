// Pure unit tests for the Jira connector core (#19). Zero credentials, zero DB,
// zero network — the deep-link builder, the two provenance strategies + their
// ordering, the canonical-transition map, secret verification, and the webhook
// parse. Run: `node --test lib/connectors`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildJiraDeepLink,
  findJiraProvenance,
  jiraCanonicalTransition,
  jiraIssueExternalRef,
  parseJiraEvent,
  parseJiraIssueUrl,
  verifyJiraSecret,
  JIRA_DECISION_PROPERTY,
} from "../jira.ts";

const DECISION = "11111111-2222-3333-4444-555555555555";
const TOKEN = `causent-decision-${DECISION}`;

// --- deep-link builder --------------------------------------------------------

test("Jira deep-link: CreateIssueDetails URL with pid/issuetype, token in description + labels", () => {
  const url = buildJiraDeepLink({
    baseUrl: "https://acme.atlassian.net/",
    projectId: "10001",
    issueTypeId: "10002",
    summary: "Ship the onboarding checklist",
    description: "Add a 3-step checklist to first-run.",
    decisionId: DECISION,
  });
  assert.ok(url.startsWith("https://acme.atlassian.net/secure/CreateIssueDetails!init.jspa?"));
  const qs = new URL(url).searchParams;
  assert.equal(qs.get("pid"), "10001");
  assert.equal(qs.get("issuetype"), "10002");
  assert.equal(qs.get("summary"), "Ship the onboarding checklist");
  assert.equal(qs.get("labels"), TOKEN); // strategy-1-ish: label carries the token
  // the token also rides in the description (strategy 2, survives a stripped label)
  assert.match(qs.get("description") ?? "", /Add a 3-step checklist/);
  assert.match(qs.get("description") ?? "", new RegExp(TOKEN));
});

test("jiraIssueExternalRef mirrors the github:issue scheme", () => {
  assert.equal(jiraIssueExternalRef("ORB-42"), "jira:issue:ORB-42");
});

// --- provenance strategies + ordering ----------------------------------------

test("strategy 1: the issue property is preferred, from a bare decision id", () => {
  const p = findJiraProvenance({ issueProperty: DECISION, labels: [], description: null });
  assert.deepEqual(p, { token: TOKEN, decisionId: DECISION, strategy: "issue_property" });
});

test("strategy 1: the issue property also accepts the full token form", () => {
  const p = findJiraProvenance({ issueProperty: TOKEN });
  assert.equal(p?.strategy, "issue_property");
  assert.equal(p?.decisionId, DECISION);
});

test("strategy 2: scan the labels when there is no issue property", () => {
  const p = findJiraProvenance({ labels: ["backend", TOKEN], description: "unrelated" });
  assert.deepEqual(p, { token: TOKEN, decisionId: DECISION, strategy: "scan" });
});

test("strategy 2: scan the description when the label was stripped", () => {
  const p = findJiraProvenance({ labels: [], description: `context\n\n${TOKEN}` });
  assert.equal(p?.strategy, "scan");
  assert.equal(p?.token, TOKEN);
});

test("ordering: issue property WINS over a scannable token in labels/description", () => {
  const p = findJiraProvenance({
    issueProperty: DECISION,
    labels: [TOKEN],
    description: TOKEN,
  });
  assert.equal(p?.strategy, "issue_property"); // property preferred, not scan
});

test("an invalid issue property falls through to the scan (never a false attribution)", () => {
  const p = findJiraProvenance({ issueProperty: "garbage", labels: [TOKEN] });
  assert.equal(p?.strategy, "scan");
  const none = findJiraProvenance({ issueProperty: "garbage", labels: [], description: "none" });
  assert.equal(none, null);
});

// --- canonical transition map ------------------------------------------------

test("created -> LEVER_ACTIVE", () => {
  assert.equal(jiraCanonicalTransition({ webhookEvent: "jira:issue_created" }), "LEVER_ACTIVE");
});

test("Done + Done/Fixed -> LEVER_SHIPPED", () => {
  const base = { webhookEvent: "jira:issue_updated", statusCategoryKey: "done" };
  assert.equal(jiraCanonicalTransition({ ...base, resolutionName: "Done" }), "LEVER_SHIPPED");
  assert.equal(jiraCanonicalTransition({ ...base, resolutionName: "Fixed" }), "LEVER_SHIPPED");
});

test("Done + Won't Do -> LEVER_DROPPED", () => {
  assert.equal(
    jiraCanonicalTransition({
      webhookEvent: "jira:issue_updated",
      statusCategoryKey: "done",
      resolutionName: "Won't Do",
    }),
    "LEVER_DROPPED",
  );
});

test("removed from sprint while NOT Done -> LEVER_DROPPED; while Done -> null", () => {
  assert.equal(
    jiraCanonicalTransition({
      webhookEvent: "jira:issue_updated",
      statusCategoryKey: "indeterminate",
      sprintRemoved: true,
    }),
    "LEVER_DROPPED",
  );
  // pulling a finished ticket out of a sprint is housekeeping, not a drop
  assert.equal(
    jiraCanonicalTransition({
      webhookEvent: "jira:issue_updated",
      statusCategoryKey: "done",
      resolutionName: "Done",
      sprintRemoved: true,
    }),
    "LEVER_SHIPPED",
  );
});

test("re-point / re-assign (status change, no resolution) -> null", () => {
  assert.equal(
    jiraCanonicalTransition({
      webhookEvent: "jira:issue_updated",
      statusCategoryKey: "indeterminate",
      resolutionName: null,
    }),
    null,
  );
});

// --- secret verification ------------------------------------------------------

test("verifyJiraSecret: match / mismatch / length-diff / empty", () => {
  assert.equal(verifyJiraSecret("s3cr3t", "s3cr3t"), true);
  assert.equal(verifyJiraSecret("s3cr3t", "nope123"), false);
  assert.equal(verifyJiraSecret("s3cr3t", "s3cr3"), false); // length differs
  assert.equal(verifyJiraSecret("", "s3cr3t"), false);
  assert.equal(verifyJiraSecret("s3cr3t", null), false);
});

// --- webhook parse ------------------------------------------------------------

test("parseJiraEvent: read-only create (token in description) -> LEVER_ACTIVE + scan", () => {
  const ev = parseJiraEvent({
    webhookEvent: "jira:issue_created",
    issue: {
      key: "ORB-42",
      self: "https://acme.atlassian.net/rest/api/3/issue/10010",
      fields: { description: `Do the thing\n\n${TOKEN}`, labels: [] },
    },
  });
  assert.equal(ev.canonical, "LEVER_ACTIVE");
  assert.equal(ev.strategy, "scan");
  assert.equal(ev.token, TOKEN);
  assert.equal(ev.decisionId, DECISION);
  assert.equal(ev.externalRef, "jira:issue:ORB-42");
  assert.equal(ev.issueKey, "ORB-42");
});

test("parseJiraEvent: property-expanded webhook -> strategy issue_property", () => {
  const ev = parseJiraEvent({
    webhookEvent: "jira:issue_created",
    issue: {
      key: "ORB-9",
      fields: { labels: [], description: null },
      properties: { [JIRA_DECISION_PROPERTY]: DECISION },
    },
  });
  assert.equal(ev.strategy, "issue_property");
  assert.equal(ev.token, TOKEN);
});

test("parseJiraEvent: Done + Won't Do -> LEVER_DROPPED", () => {
  const ev = parseJiraEvent({
    webhookEvent: "jira:issue_updated",
    issue: {
      key: "ORB-42",
      fields: {
        labels: [TOKEN],
        status: { statusCategory: { key: "done" } },
        resolution: { name: "Won't Do" },
      },
    },
  });
  assert.equal(ev.canonical, "LEVER_DROPPED");
  assert.equal(ev.token, TOKEN);
});

test("parseJiraIssueUrl parses a /browse/KEY-n URL", () => {
  assert.deepEqual(parseJiraIssueUrl("https://acme.atlassian.net/browse/ORB-42"), { key: "ORB-42" });
  assert.equal(parseJiraIssueUrl("https://acme.atlassian.net/dashboard"), null);
});
