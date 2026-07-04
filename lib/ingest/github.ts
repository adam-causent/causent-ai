// GitHub ingestion — capped, idempotent backfill of merged PRs + resolved issues
// into the SAME `actions` rows the persistence bridge consumes
// (supabase/migrations/20260703223627_v1_schema.sql: actions.source in
// {github_pr, github_issue, manual}, external_ref, ship_ts, effective_date,
// status, rationale_richtext jsonb).
//
// This file is PURE: no network, no env, no `@/` imports. Everything with a side
// effect is injected behind a small interface so the whole pipeline is exercised
// against recorded fixtures with zero live token (see lib/ingest/__tests__).
//
//   GitHubTransport (fetch a path)  ─┐
//                                    ├─▶ requestWithBackoff (honors Retry-After)
//   ActionStore (dedup + insert)   ─┘        │
//                                            ▼
//        ingestActions()  ── paginate → window-cap → count-cap → parse →
//                            dedup on external_ref → insert new  ── IngestResult
//
// The real transport (lib/ingest/github-transport.ts) and the real Supabase store
// (lib/ingest/github-store.ts) are thin adapters over these interfaces; they are
// the ONLY pieces that need a live GitHub token / DB connection to go live.

// ---------------------------------------------------------------------------
// Defaults — the "capped recent window".
// ---------------------------------------------------------------------------

/** Only ship events within this many days of `now` are backfilled. */
export const DEFAULT_WINDOW_DAYS = 90;
/** Hard cap on how many action rows one ingest run yields (newest first). */
export const DEFAULT_MAX_ITEMS = 200;
/** GitHub REST page size (max the API allows). */
export const DEFAULT_PER_PAGE = 100;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// GitHub REST shapes — the narrow subset of fields we read. Defensive: every
// field we branch on is validated before use, since PR/issue bodies are
// UNTRUSTED text (docs/designs/security-and-auth.md S4/T-PI — stored as data,
// never interpolated into an LLM prompt here).
// ---------------------------------------------------------------------------

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  /** ISO-8601 UTC when the PR merged; null if it was closed without merging. */
  merged_at: string | null;
  /** ISO-8601 UTC last-update — the `sort=updated` field driving pagination stop. */
  updated_at: string;
  state: string;
  user?: { login: string } | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string; // "open" | "closed"
  /** "completed" (resolved) | "not_planned" | "reopened" | null. */
  state_reason: string | null;
  closed_at: string | null;
  /** ISO-8601 UTC last-update — the `sort=updated` field driving pagination stop. */
  updated_at: string;
  /** Present iff this "issue" is really a PR — the issues endpoint returns both. */
  pull_request?: unknown;
  user?: { login: string } | null;
}

// ---------------------------------------------------------------------------
// Output shape — mirrors the `actions` columns the bridge reads (it uses
// external_ref/source for the display ref and effective_date as the ITS split).
// ---------------------------------------------------------------------------

/** TipTap-ish rich-text doc for actions.rationale_richtext, matching the shape
 *  seed_demo.py writes and lib/data/actions.ts reads. */
export interface RationaleDoc {
  type: "doc";
  title: string;
  content: Array<{ type: "paragraph"; content: Array<{ type: "text"; text: string }> }>;
  meta: { expected_metric?: string; source_url?: string; author?: string };
}

/** A row ready to INSERT into public.actions. action_id/scope defaults, cluster_id
 *  and owner_id are left to the DB / bridge — we only set what GitHub gives us. */
export interface ActionRow {
  scope_id: string;
  source: "github_pr" | "github_issue";
  /** Stable dedup key, e.g. "github:pr:8107" / "github:issue:412". */
  external_ref: string;
  /** ISO-8601 UTC timestamptz of the ship event (merged_at / closed_at). */
  ship_ts: string;
  /** UTC calendar date of ship_ts — the bridge's ITS intervention date. */
  effective_date: string;
  status: "merged" | "completed";
  rationale_richtext: RationaleDoc;
}

// ---------------------------------------------------------------------------
// Injected side-effect interfaces.
// ---------------------------------------------------------------------------

/** A single HTTP response, structurally compatible with the WHATWG `Response`
 *  (so the real transport can return `fetch()`'s result almost verbatim). */
export interface GitHubHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** The transport the ingest depends on: GET a path under api.github.com. */
export interface GitHubTransport {
  fetch(path: string): Promise<GitHubHttpResponse>;
}

/** Persistence seam: look up which external_refs already exist (dedup) and insert
 *  the fresh rows. The real impl is Supabase-backed; tests use an in-memory fake. */
export interface ActionStore {
  existingRefs(scopeId: string, refs: string[]): Promise<Set<string>>;
  /** Insert the rows; returns how many landed. */
  insert(rows: ActionRow[]): Promise<number>;
}

export interface BackoffOptions {
  /** Max retries on a rate-limit response before giving up. Default 5. */
  maxRetries?: number;
  /** Injected sleeper (ms). Default: real setTimeout. Tests pass a no-op/spy. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock (ms epoch), used for X-RateLimit-Reset math. Default Date.now. */
  now?: () => number;
}

export interface IngestOptions {
  scopeId: string;
  owner: string;
  repo: string;
  /** Recent-window cap in days. Default DEFAULT_WINDOW_DAYS (90). */
  windowDays?: number;
  /** Count cap on emitted rows (newest first). Default DEFAULT_MAX_ITEMS. */
  maxItems?: number;
  /** Injected clock for the window boundary. Default: new Date(). */
  now?: () => Date;
  /** REST page size. Default DEFAULT_PER_PAGE (100); lowered in tests. */
  perPage?: number;
  backoff?: BackoffOptions;
}

export interface IngestResult {
  /** Raw PR/issue objects that fell inside the window before capping. */
  fetched: number;
  /** Action rows after parse + count cap (what we attempted to persist). */
  capped: number;
  /** Rows newly inserted this run. */
  inserted: number;
  /** Rows skipped because their external_ref already existed (idempotency). */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Rate-limit-aware request.
// ---------------------------------------------------------------------------

export class GitHubRequestError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string) {
    super(`GitHub request failed: ${status} ${path}`);
    this.name = "GitHubRequestError";
    this.status = status;
    this.path = path;
  }
}

function isRateLimited(res: GitHubHttpResponse): boolean {
  if (res.status === 429) return true;
  // GitHub signals a primary-rate-limit exhaustion as 403 with remaining == 0.
  if (res.status === 403) {
    return res.headers.get("retry-after") != null || res.headers.get("x-ratelimit-remaining") === "0";
  }
  return false;
}

/** How long to wait before the next attempt, honoring (in priority order)
 *  Retry-After seconds, then X-RateLimit-Reset epoch, then exponential fallback. */
function retryDelayMs(res: GitHubHttpResponse, attempt: number, nowMs: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter != null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset != null) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) return Math.max(0, resetMs - nowMs);
  }
  return Math.min(60_000, 1000 * 2 ** attempt); // capped exponential backoff
}

/** GET `path` and return parsed JSON, retrying on rate-limit responses while
 *  honoring Retry-After / X-RateLimit-Reset. Throws on any other non-2xx. */
export async function requestWithBackoff(
  transport: GitHubTransport,
  path: string,
  opts?: BackoffOptions,
): Promise<unknown> {
  const maxRetries = opts?.maxRetries ?? 5;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts?.now ?? (() => Date.now());

  for (let attempt = 0; ; attempt++) {
    const res = await transport.fetch(path);
    if (res.status >= 200 && res.status < 300) return res.json();
    if (isRateLimited(res) && attempt < maxRetries) {
      await sleep(retryDelayMs(res, attempt, now()));
      continue;
    }
    throw new GitHubRequestError(res.status, path);
  }
}

// ---------------------------------------------------------------------------
// Parsing: GitHub object -> ActionRow (or null when it is not a ship event).
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp -> "YYYY-MM-DD" (the UTC calendar date), or null when
 *  `iso` is unparseable. Returning null (rather than throwing on `.toISOString()`
 *  of an Invalid Date) keeps one malformed ship timestamp from poisoning the whole
 *  backfill run — the untrusted item is dropped, not fatal. */
function utcDateOrNull(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function buildRationale(
  title: string,
  body: string | null,
  sourceUrl: string,
  author: string | undefined,
): RationaleDoc {
  const lines = (body ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 8); // keep it bounded; the body is untrusted, unbounded text
  const paragraphs = lines.length > 0 ? lines : [title];
  return {
    type: "doc",
    title,
    content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    // expected_metric is intentionally unset: GitHub cannot know the hypothesized
    // target metric. A human sets it later in the Actions tab (falls back in the UI).
    meta: { source_url: sourceUrl, author },
  };
}

/** A merged PR becomes an action; an unmerged (closed-without-merge) PR does not. */
export function parsePullRequestToAction(pr: GitHubPullRequest, scopeId: string): ActionRow | null {
  if (pr.merged_at == null) return null;
  const effective_date = utcDateOrNull(pr.merged_at);
  if (effective_date == null) return null; // unparseable merged_at — skip, don't crash
  return {
    scope_id: scopeId,
    source: "github_pr",
    external_ref: `github:pr:${pr.number}`,
    ship_ts: pr.merged_at,
    effective_date,
    status: "merged",
    rationale_richtext: buildRationale(pr.title, pr.body, pr.html_url, pr.user?.login),
  };
}

/** A RESOLVED issue (closed with state_reason "completed") becomes an action.
 *  Skips: still-open issues, "not_planned" closures, and issue objects that are
 *  actually PRs (the issues endpoint returns both — the `pull_request` field). */
export function parseIssueToAction(issue: GitHubIssue, scopeId: string): ActionRow | null {
  if (issue.pull_request != null) return null; // it's a PR in disguise
  if (issue.state !== "closed") return null;
  if (issue.state_reason !== "completed") return null;
  if (issue.closed_at == null) return null;
  const effective_date = utcDateOrNull(issue.closed_at);
  if (effective_date == null) return null; // unparseable closed_at — skip, don't crash
  return {
    scope_id: scopeId,
    source: "github_issue",
    external_ref: `github:issue:${issue.number}`,
    ship_ts: issue.closed_at,
    effective_date,
    status: "completed",
    rationale_richtext: buildRationale(issue.title, issue.body, issue.html_url, issue.user?.login),
  };
}

// ---------------------------------------------------------------------------
// Pagination with early stop on the recent window.
// ---------------------------------------------------------------------------

/** Paginate `basePath` (sorted newest-first by `updated`), returning every item
 *  whose `recencyOf` timestamp is within the window. Early-stops once a full page
 *  is entirely older than the cutoff — the "capped recent window". recency is
 *  keyed on updated_at (the SORT field), NOT on whether the item is a keeper, so
 *  a non-keeper (e.g. an unmerged PR) between recent merges never halts paging. */
async function collectWindowed<T>(
  transport: GitHubTransport,
  basePath: string,
  recencyOf: (item: T) => string | null,
  cutoffMs: number,
  maxItems: number,
  perPage: number,
  backoff: BackoffOptions | undefined,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const body = await requestWithBackoff(
      transport,
      `${basePath}${sep}per_page=${perPage}&page=${page}`,
      backoff,
    );
    if (!Array.isArray(body) || body.length === 0) break;
    const items = body as T[];
    let anyRecent = false;
    for (const item of items) {
      const ts = recencyOf(item);
      if (ts != null && Date.parse(ts) >= cutoffMs) {
        out.push(item);
        anyRecent = true;
      }
    }
    if (items.length < perPage) break; // last page
    if (!anyRecent) break; // sorted desc: everything past here is older than the window
    if (out.length >= maxItems) break; // count cap reached
  }
  return out;
}

// ---------------------------------------------------------------------------
// Idempotent persist.
// ---------------------------------------------------------------------------

/** Dedup `rows` against what's already stored (on external_ref) and insert only
 *  the fresh ones. Idempotent by construction: re-running with the same GitHub
 *  data inserts nothing the second time. */
export async function upsertActions(
  store: ActionStore,
  rows: ActionRow[],
  scopeId: string,
): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const existing = await store.existingRefs(scopeId, rows.map((r) => r.external_ref));
  const fresh = rows.filter((r) => !existing.has(r.external_ref));
  const inserted = fresh.length > 0 ? await store.insert(fresh) : 0;
  return { inserted, skipped: rows.length - fresh.length };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

/** Backfill merged PRs + resolved issues from `owner/repo` into `actions`,
 *  capped to a recent window (days) and a max count, deduped on external_ref. */
export async function ingestActions(
  transport: GitHubTransport,
  store: ActionStore,
  opts: IngestOptions,
): Promise<IngestResult> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const nowMs = (opts.now ? opts.now() : new Date()).getTime();
  const cutoffMs = nowMs - windowDays * DAY_MS;
  const { owner, repo, scopeId } = opts;

  // Paginate by recency (updated_at) so a non-keeper never truncates the scan.
  const pulls = await collectWindowed<GitHubPullRequest>(
    transport,
    `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc`,
    (pr) => pr.updated_at,
    cutoffMs,
    maxItems,
    perPage,
    opts.backoff,
  );
  const issues = await collectWindowed<GitHubIssue>(
    transport,
    `/repos/${owner}/${repo}/issues?state=closed&sort=updated&direction=desc`,
    (issue) => issue.updated_at,
    cutoffMs,
    maxItems,
    perPage,
    opts.backoff,
  );

  // Keep-filter (merged / resolved) THEN apply the ship-date window: a recently
  // touched PR may have merged long before the window — its ship event is stale.
  const rows: ActionRow[] = [];
  for (const pr of pulls) {
    const row = parsePullRequestToAction(pr, scopeId);
    if (row && Date.parse(row.ship_ts) >= cutoffMs) rows.push(row);
  }
  for (const issue of issues) {
    const row = parseIssueToAction(issue, scopeId);
    if (row && Date.parse(row.ship_ts) >= cutoffMs) rows.push(row);
  }

  // Newest ship first, then apply the count cap across BOTH sources combined.
  rows.sort((a, b) => (a.ship_ts < b.ship_ts ? 1 : a.ship_ts > b.ship_ts ? -1 : 0));
  const capped = rows.slice(0, maxItems);

  const { inserted, skipped } = await upsertActions(store, capped, scopeId);
  return { fetched: pulls.length + issues.length, capped: capped.length, inserted, skipped };
}
