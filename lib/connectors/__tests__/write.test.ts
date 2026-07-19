// Pure unit tests for the write-scope create adapters (#19). Zero credentials,
// zero network — a MOCK transport records calls and returns canned responses, so
// every branch (GitHub label, Jira create + issue-property, property failure,
// create failure) is exercised offline. Run: `node --test lib/connectors`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  gitHubIssueCreator,
  jiraIssueCreator,
  type WriteTransport,
} from "../write.ts";

const DECISION = "11111111-2222-3333-4444-555555555555";
const TOKEN = `causent-decision-${DECISION}`;

type Call = { method: string; url: string; body?: unknown };

function mockTransport(
  responder: (call: Call) => { status: number; json?: unknown; text?: string },
): { transport: WriteTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: WriteTransport = {
    async request(method, url, body) {
      const call = { method, url, body };
      calls.push(call);
      const r = responder(call);
      return {
        status: r.status,
        async json() {
          return r.json ?? {};
        },
        async text() {
          return r.text ?? JSON.stringify(r.json ?? {});
        },
      };
    },
  };
  return { transport, calls };
}

// --- GitHub ------------------------------------------------------------------

test("GitHub creator: POSTs the issue with the provenance label, returns github:issue ref", async () => {
  const { transport, calls } = mockTransport(() => ({
    status: 201,
    json: { number: 77, html_url: "https://github.com/acme/orbit/issues/77" },
  }));
  const creator = gitHubIssueCreator(transport, { owner: "acme", repo: "orbit" });
  const out = await creator.create({ decisionId: DECISION, title: "Ship it", body: "do the thing" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://api.github.com/repos/acme/orbit/issues");
  const body = calls[0].body as { labels: string[]; body: string; title: string };
  assert.deepEqual(body.labels, [TOKEN]);
  assert.match(body.body, new RegExp(TOKEN)); // token in body too (strategy-2 backstop)
  assert.equal(out.externalRef, "github:issue:77");
  assert.equal(out.url, "https://github.com/acme/orbit/issues/77");
  assert.equal(out.strategy, "label");
});

test("GitHub creator: a non-2xx create throws (never silently drops the ticket)", async () => {
  const { transport } = mockTransport(() => ({ status: 422, text: "validation failed" }));
  const creator = gitHubIssueCreator(transport, { owner: "acme", repo: "orbit" });
  await assert.rejects(
    () => creator.create({ decisionId: DECISION, title: "x", body: "y" }),
    /GitHub issue create failed \(422\)/,
  );
});

// --- Jira --------------------------------------------------------------------

test("Jira creator: creates the issue then sets the causent.decisionId property (strategy issue_property)", async () => {
  const { transport, calls } = mockTransport((call) =>
    call.method === "POST"
      ? { status: 201, json: { key: "ORB-9" } }
      : { status: 200 },
  );
  const creator = jiraIssueCreator(transport, {
    baseUrl: "https://acme.atlassian.net/",
    projectKey: "ORB",
    issueTypeId: "10002",
  });
  const out = await creator.create({ decisionId: DECISION, title: "Ship it", body: "do the thing" });

  // 1st call: create with project/type/labels + ADF description.
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://acme.atlassian.net/rest/api/3/issue");
  const fields = (calls[0].body as { fields: Record<string, unknown> }).fields;
  assert.equal((fields.project as { key: string }).key, "ORB");
  assert.deepEqual(fields.labels, [TOKEN]);
  // 2nd call: PUT the issue property.
  assert.equal(calls[1].method, "PUT");
  assert.equal(
    calls[1].url,
    "https://acme.atlassian.net/rest/api/3/issue/ORB-9/properties/causent.decisionId",
  );
  assert.equal(calls[1].body, DECISION);

  assert.equal(out.externalRef, "jira:issue:ORB-9");
  assert.equal(out.url, "https://acme.atlassian.net/browse/ORB-9");
  assert.equal(out.strategy, "issue_property");
});

test("Jira creator: a failed property PUT downgrades to the label strategy (ticket still created)", async () => {
  const { transport } = mockTransport((call) =>
    call.method === "POST" ? { status: 201, json: { key: "ORB-10" } } : { status: 403 },
  );
  const creator = jiraIssueCreator(transport, {
    baseUrl: "https://acme.atlassian.net",
    projectKey: "ORB",
    issueTypeId: "10002",
  });
  const out = await creator.create({ decisionId: DECISION, title: "x", body: "y" });
  assert.equal(out.externalRef, "jira:issue:ORB-10");
  assert.equal(out.strategy, "label"); // property failed → backstop
});

test("Jira creator: a failed issue create throws", async () => {
  const { transport } = mockTransport(() => ({ status: 400, text: "bad request" }));
  const creator = jiraIssueCreator(transport, {
    baseUrl: "https://acme.atlassian.net",
    projectKey: "ORB",
    issueTypeId: "10002",
  });
  await assert.rejects(
    () => creator.create({ decisionId: DECISION, title: "x", body: "y" }),
    /Jira issue create failed \(400\)/,
  );
});
