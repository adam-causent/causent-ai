// Fixture-driven tests for the GitHub ingestion pipeline (lib/ingest/github.ts).
// Zero live token: a fake transport serves recorded PR/issue JSON, and an
// in-memory ActionStore stands in for Supabase. Run: `node --test lib/ingest`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GitHubRequestError,
  ingestActions,
  parseIssueToAction,
  parsePullRequestToAction,
  requestWithBackoff,
  upsertActions,
  type ActionRow,
  type ActionStore,
  type GitHubHttpResponse,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubTransport,
} from "../github.ts";

// --- fixtures --------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, "..", "__fixtures__");
const readFixture = <T>(name: string): T[] =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T[];

const PULLS = readFixture<GitHubPullRequest>("pulls-closed.json");
const ISSUES = readFixture<GitHubIssue>("issues-closed.json");

const SCOPE = "ca5e0000-0000-0000-0000-0000000000d3";
// Fixed "now" so the 90-day window is deterministic (cutoff = 2025-01-01).
const NOW = () => new Date("2025-04-01T00:00:00Z");

// --- fakes -----------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): GitHubHttpResponse {
  return { status, headers: { get: () => null }, json: async () => body };
}

/** Serves the fixture arrays, honoring `?page=&per_page=` like the REST API. */
function fixtureTransport(): GitHubTransport {
  return {
    async fetch(path: string): Promise<GitHubHttpResponse> {
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const page = Number(query.get("page") ?? "1");
      const perPage = Number(query.get("per_page") ?? "100");
      const source = path.includes("/pulls") ? PULLS : ISSUES;
      const start = (page - 1) * perPage;
      return jsonResponse(source.slice(start, start + perPage));
    },
  };
}

class InMemoryStore implements ActionStore {
  readonly rows = new Map<string, ActionRow>();
  async existingRefs(_scopeId: string, refs: string[]): Promise<Set<string>> {
    return new Set(refs.filter((r) => this.rows.has(r)));
  }
  async insert(rows: ActionRow[]): Promise<number> {
    for (const r of rows) this.rows.set(r.external_ref, r);
    return rows.length;
  }
}

const refsOf = (store: InMemoryStore) => new Set(store.rows.keys());

// --- parsing ---------------------------------------------------------------

test("parsePullRequestToAction maps a merged PR to an action row", () => {
  const merged = PULLS.find((p) => p.number === 8256)!;
  const row = parsePullRequestToAction(merged, SCOPE);
  assert.ok(row);
  assert.equal(row.source, "github_pr");
  assert.equal(row.external_ref, "github:pr:8256");
  assert.equal(row.status, "merged");
  assert.equal(row.effective_date, "2025-03-05");
  assert.equal(row.ship_ts, "2025-03-05T12:00:00Z");
  assert.equal(row.scope_id, SCOPE);
  assert.equal(row.rationale_richtext.title, "Signup Funnel Rebuild");
  assert.equal(row.rationale_richtext.meta.source_url, merged.html_url);
  assert.equal(row.rationale_richtext.meta.author, "arya");
});

test("parsePullRequestToAction returns null for a closed-but-unmerged PR", () => {
  const unmerged = PULLS.find((p) => p.number === 8210)!;
  assert.equal(parsePullRequestToAction(unmerged, SCOPE), null);
});

test("parseIssueToAction maps a resolved (completed) issue to an action row", () => {
  const resolved = ISSUES.find((i) => i.number === 412)!;
  const row = parseIssueToAction(resolved, SCOPE);
  assert.ok(row);
  assert.equal(row.source, "github_issue");
  assert.equal(row.external_ref, "github:issue:412");
  assert.equal(row.status, "completed");
  assert.equal(row.effective_date, "2025-02-20");
});

test("parseIssueToAction skips not_planned, still-open, and PR-shaped issues", () => {
  const notPlanned = ISSUES.find((i) => i.number === 398)!;
  const prShaped = ISSUES.find((i) => i.number === 8256)!;
  assert.equal(parseIssueToAction(notPlanned, SCOPE), null);
  assert.equal(parseIssueToAction(prShaped, SCOPE), null); // has pull_request
  const open: GitHubIssue = { ...notPlanned, state: "open", state_reason: null };
  assert.equal(parseIssueToAction(open, SCOPE), null);
});

test("parsePullRequestToAction drops (does not throw on) an unparseable merged_at", () => {
  const merged = PULLS.find((p) => p.number === 8256)!;
  const bad: GitHubPullRequest = { ...merged, merged_at: "not-a-date" };
  // A single malformed timestamp must not abort the backfill — it's skipped.
  assert.equal(parsePullRequestToAction(bad, SCOPE), null);
});

test("parseIssueToAction drops (does not throw on) an unparseable closed_at", () => {
  const resolved = ISSUES.find((i) => i.number === 412)!;
  const bad: GitHubIssue = { ...resolved, closed_at: "garbage" };
  assert.equal(parseIssueToAction(bad, SCOPE), null);
});

// --- rate-limit backoff ----------------------------------------------------

test("requestWithBackoff honors Retry-After, then returns the body", async () => {
  const slept: number[] = [];
  let call = 0;
  const transport: GitHubTransport = {
    async fetch() {
      call += 1;
      if (call === 1) {
        return {
          status: 429,
          headers: { get: (n) => (n.toLowerCase() === "retry-after" ? "2" : null) },
          json: async () => ({}),
        };
      }
      return jsonResponse({ ok: true });
    },
  };
  const body = await requestWithBackoff(transport, "/x", {
    sleep: async (ms) => void slept.push(ms),
  });
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(slept, [2000]); // waited exactly the Retry-After seconds
  assert.equal(call, 2);
});

test("requestWithBackoff falls back to X-RateLimit-Reset when no Retry-After", async () => {
  const slept: number[] = [];
  let call = 0;
  const resetEpoch = 1_700_000_060; // 60s after the fake clock below
  const transport: GitHubTransport = {
    async fetch() {
      call += 1;
      if (call === 1) {
        return {
          status: 403,
          headers: {
            get: (n) => {
              const k = n.toLowerCase();
              if (k === "x-ratelimit-remaining") return "0";
              if (k === "x-ratelimit-reset") return String(resetEpoch);
              return null;
            },
          },
          json: async () => ({}),
        };
      }
      return jsonResponse({ ok: true });
    },
  };
  await requestWithBackoff(transport, "/x", {
    sleep: async (ms) => void slept.push(ms),
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(slept, [60_000]);
});

test("requestWithBackoff throws GitHubRequestError on a non-rate-limit failure", async () => {
  const transport: GitHubTransport = { async fetch() { return jsonResponse({}, 404); } };
  await assert.rejects(
    requestWithBackoff(transport, "/missing", { maxRetries: 0 }),
    (e: unknown) => e instanceof GitHubRequestError && e.status === 404,
  );
});

// --- end-to-end ingest -----------------------------------------------------

test("ingestActions parses PRs + issues into deduped action rows in the window", async () => {
  const store = new InMemoryStore();
  const result = await ingestActions(fixtureTransport(), store, {
    scopeId: SCOPE,
    owner: "acme",
    repo: "orbit",
    now: NOW,
    perPage: 1, // one item per page -> exercises pagination
  });
  assert.equal(result.inserted, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.capped, 3);
  assert.deepEqual(
    refsOf(store),
    new Set(["github:pr:8256", "github:pr:8107", "github:issue:412"]),
  );
});

test("ingestActions caps to the recent window (excludes the old PR #7900)", async () => {
  const store = new InMemoryStore();
  await ingestActions(fixtureTransport(), store, {
    scopeId: SCOPE, owner: "acme", repo: "orbit", now: NOW, perPage: 1,
  });
  assert.ok(!refsOf(store).has("github:pr:7900"));
});

test("ingestActions respects a tighter windowDays", async () => {
  const store = new InMemoryStore();
  // cutoff = 2025-04-01 - 40d = 2025-02-20: keeps PR #8256 (03-05) and issue #412
  // (02-20, boundary inclusive); drops PR #8107 (02-03).
  const result = await ingestActions(fixtureTransport(), store, {
    scopeId: SCOPE, owner: "acme", repo: "orbit", now: NOW, perPage: 1, windowDays: 40,
  });
  assert.equal(result.capped, 2);
  assert.deepEqual(refsOf(store), new Set(["github:pr:8256", "github:issue:412"]));
});

test("ingestActions applies the maxItems count cap, newest first", async () => {
  const store = new InMemoryStore();
  const result = await ingestActions(fixtureTransport(), store, {
    scopeId: SCOPE, owner: "acme", repo: "orbit", now: NOW, perPage: 1, maxItems: 1,
  });
  assert.equal(result.capped, 1);
  assert.equal(result.inserted, 1);
  assert.deepEqual(refsOf(store), new Set(["github:pr:8256"])); // the newest ship
});

test("ingestActions is idempotent: a second run inserts nothing", async () => {
  const store = new InMemoryStore();
  const opts = { scopeId: SCOPE, owner: "acme", repo: "orbit", now: NOW, perPage: 1 };
  const first = await ingestActions(fixtureTransport(), store, opts);
  const second = await ingestActions(fixtureTransport(), store, opts);
  assert.equal(first.inserted, 3);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 3);
  assert.equal(store.rows.size, 3); // no duplicates
});

// --- upsert unit -----------------------------------------------------------

test("upsertActions skips refs that already exist", async () => {
  const store = new InMemoryStore();
  const row = parsePullRequestToAction(PULLS.find((p) => p.number === 8256)!, SCOPE)!;
  const a = await upsertActions(store, [row], SCOPE);
  const b = await upsertActions(store, [row], SCOPE);
  assert.deepEqual(a, { inserted: 1, skipped: 0 });
  assert.deepEqual(b, { inserted: 0, skipped: 1 });
});
