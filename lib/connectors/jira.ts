// Jira connector — PURE core for the create-from-decision lever flow (#19, C6).
//
// Mirrors lib/connectors/github.ts: no network, no env, no DB — the deep-link
// builder, the provenance strategies, the canonical-transition map, and the
// webhook parse, all exercisable against synthetic inputs with zero credentials.
// The live REST calls live in lib/connectors/jira-write.ts; the DB writes live in
// lib/levers/*; the route handlers are the thin HTTP adapters.
//
// Jira is second by design (the issue #19 rationale): its create deep-link is
// clunkier than GitHub's `issues/new` and cannot set an issue property, so the
// provenance token rides in the description + labels. Detection therefore runs
// the SAME two strategies as GitHub, in the locked A3 order:
//   1. the issue property  causent.decisionId  (preferred — the write path sets
//      it; a reconcile poll / property-expanded webhook can read it), then
//   2. a description/label token scan for  causent-decision-<id>  (the read-only
//      deep-link path, which can only reach the description + labels).
// The token IS `causent-decision-<id>` — the SAME scheme GitHub uses, so
// levers.provenance_token is uniform across trackers and detection is idempotent
// on it regardless of which tracker or strategy produced the match.

import {
  decisionIdFromToken,
  findProvenance,
  provenanceToken,
  type Canonical,
} from "./github.ts";
import { timingSafeEqual } from "node:crypto";

/** The Jira issue property key that carries the decision id (write path). */
export const JIRA_DECISION_PROPERTY = "causent.decisionId";

// ---------------------------------------------------------------------------
// Deep-link builder (read-only default path — the user creates the issue).
// ---------------------------------------------------------------------------

export interface JiraDeepLinkParams {
  /** The site base, e.g. "https://acme.atlassian.net" (no trailing slash needed). */
  baseUrl: string;
  /** Numeric project id (pid) — resolved from the selected project at Step 5. */
  projectId: string;
  /** Numeric issue type id (e.g. Task/Story) for the target project. */
  issueTypeId: string;
  summary: string;
  description: string;
  decisionId: string;
}

/**
 * The prefilled `CreateIssueDetails!init.jspa` URL. The user clicks it, Jira opens
 * the create-issue form with summary/description/labels filled, and they submit —
 * Causent needs no write scope. Jira's deep-link CANNOT set an issue property, so
 * the provenance token goes in BOTH the description (a trailing marker line) and
 * the labels field, and detection scans them (strategy 2).
 */
export function buildJiraDeepLink(params: JiraDeepLinkParams): string {
  const token = provenanceToken(params.decisionId);
  const description = `${params.description}\n\n${token}`;
  const base = params.baseUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    pid: params.projectId,
    issuetype: params.issueTypeId,
    summary: params.summary,
    description,
    // Jira labels disallow spaces but allow dashes — the token is label-safe.
    labels: token,
  });
  return `${base}/secure/CreateIssueDetails!init.jspa?${qs.toString()}`;
}

/** Stable external_ref for a detected Jira issue (mirrors github:issue:<n>). */
export function jiraIssueExternalRef(issueKey: string): string {
  return `jira:issue:${issueKey}`;
}

// ---------------------------------------------------------------------------
// Provenance: strategy 1 (issue property) preferred, else strategy 2 (scan).
// ---------------------------------------------------------------------------

export interface JiraProvenanceInputs {
  /** The causent.decisionId issue-property value, when known (write path / poll). */
  issueProperty?: string | null;
  /** The issue labels (strategy-2 scan target). */
  labels?: string[] | null;
  /** The issue description text (strategy-2 scan target). */
  description?: string | null;
}

/**
 * Resolve the decision this issue is a lever for. Strategy 1 (the issue property)
 * wins when present — it is the write path's authoritative marker. Otherwise the
 * token is scanned out of the labels, then the description (strategy 2). Returns
 * the SAME `{ token, decisionId }` shape either way; the token is the idempotency
 * key detection matches on.
 */
export function findJiraProvenance(
  inputs: JiraProvenanceInputs,
): { token: string; decisionId: string; strategy: "issue_property" | "scan" } | null {
  // Strategy 1: the issue property (preferred).
  const prop = inputs.issueProperty?.trim();
  if (prop) {
    // The property may hold either the bare decision id or the full token.
    const decisionId = decisionIdFromToken(prop) ?? prop;
    if (/^[0-9a-fA-F-]{36}$/.test(decisionId)) {
      return { token: provenanceToken(decisionId), decisionId, strategy: "issue_property" };
    }
  }
  // Strategy 2: scan labels + description (reuse the GitHub scan — same token).
  const scan = findProvenance(inputs.labels ?? [], inputs.description ?? null);
  if (scan) return { ...scan, strategy: "scan" };
  return null;
}

// ---------------------------------------------------------------------------
// Canonical transition map (Jira issue event -> transition_events.canonical).
// ---------------------------------------------------------------------------

/** Resolutions that mean the work SHIPPED. */
const SHIP_RESOLUTIONS = new Set(["done", "fixed"]);
/** Resolutions that mean the work was DROPPED (the drift signal). */
const DROP_RESOLUTIONS = new Set(["won't do", "wont do", "won't fix", "wont fix", "duplicate", "cannot reproduce"]);

export interface JiraTransitionInputs {
  webhookEvent: string; // "jira:issue_created" | "jira:issue_updated" | ...
  /** The status category key: "new" | "indeterminate" | "done". */
  statusCategoryKey?: string | null;
  /** The resolution name, e.g. "Done" | "Won't Do" (null while unresolved). */
  resolutionName?: string | null;
  /** True when this update removed the issue from its active sprint. */
  sprintRemoved?: boolean;
}

/**
 * Map a Jira issue event to the canonical transition the schema stores.
 *   created                              -> LEVER_ACTIVE (detected/attributed)
 *   Done + a ship resolution (Done/Fixed)-> LEVER_SHIPPED
 *   Done + a drop resolution (Won't Do…) -> LEVER_DROPPED  (drift)
 *   removed from sprint while NOT Done    -> LEVER_DROPPED  (drift)
 *   re-point / re-assign / re-label       -> null (not tracked)
 */
export function jiraCanonicalTransition(inputs: JiraTransitionInputs): Canonical | null {
  if (inputs.webhookEvent === "jira:issue_created") return "LEVER_ACTIVE";

  const done = (inputs.statusCategoryKey ?? "").toLowerCase() === "done";

  // Sprint removal is a drop ONLY while the issue is not yet Done (pulling a
  // finished ticket out of a sprint is housekeeping, not a drop).
  if (inputs.sprintRemoved && !done) return "LEVER_DROPPED";

  if (done && inputs.resolutionName) {
    const res = inputs.resolutionName.trim().toLowerCase();
    if (DROP_RESOLUTIONS.has(res)) return "LEVER_DROPPED";
    if (SHIP_RESOLUTIONS.has(res)) return "LEVER_SHIPPED";
    // Any other resolution on a Done issue counts as shipped (the work landed).
    return "LEVER_SHIPPED";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webhook secret verification. Jira webhooks don't HMAC-sign by default; v1
// authenticates with a shared secret the app configures as a custom header
// (or ?secret= query param) on the webhook. Constant-time compare; never throws.
// ---------------------------------------------------------------------------

export function verifyJiraSecret(secret: string, provided: string | null): boolean {
  if (!secret || !provided) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Webhook payload parsing (narrow, defensive — the body is untrusted).
// ---------------------------------------------------------------------------

/** The narrow subset of a Jira issue webhook we read. */
export interface JiraWebhookPayload {
  timestamp?: number;
  webhookEvent?: string;
  issue?: {
    id?: string;
    key?: string;
    self?: string;
    fields?: {
      summary?: string | null;
      description?: string | null;
      labels?: string[] | null;
      status?: { statusCategory?: { key?: string | null } | null } | null;
      resolution?: { name?: string | null } | null;
    } | null;
    // Present only when the webhook is configured to expand properties, or when
    // a poll injected it before calling the parser.
    properties?: Record<string, unknown> | null;
  } | null;
  changelog?: { items?: Array<{ field?: string | null; toString?: string | null; to?: string | null }> } | null;
}

export interface ParsedJiraEvent {
  decisionId: string | null;
  token: string | null;
  strategy: "issue_property" | "scan" | null;
  externalRef: string | null; // jira:issue:<KEY>
  issueKey: string | null;
  self: string | null; // the issue's REST self URL (used as the UI link)
  canonical: Canonical | null;
}

function issuePropertyValue(props: Record<string, unknown> | null | undefined): string | null {
  if (!props || typeof props !== "object") return null;
  const v = (props as Record<string, unknown>)[JIRA_DECISION_PROPERTY];
  return typeof v === "string" ? v : null;
}

function sprintRemovedFromChangelog(payload: JiraWebhookPayload): boolean {
  const items = payload.changelog?.items;
  if (!Array.isArray(items)) return false;
  return items.some(
    (it) =>
      (it?.field ?? "").toLowerCase() === "sprint" &&
      // removed = the new value is empty (pulled out of every sprint).
      !((it?.toString ?? it?.to ?? "").trim()),
  );
}

/** Parse a Jira issue webhook body into the normalized detection event. */
export function parseJiraEvent(payload: JiraWebhookPayload): ParsedJiraEvent {
  const issue = payload.issue ?? null;
  const fields = issue?.fields ?? null;
  const prov = findJiraProvenance({
    issueProperty: issuePropertyValue(issue?.properties),
    labels: fields?.labels ?? [],
    description: fields?.description ?? null,
  });
  const issueKey = typeof issue?.key === "string" ? issue.key : null;
  return {
    decisionId: prov?.decisionId ?? null,
    token: prov?.token ?? null,
    strategy: prov?.strategy ?? null,
    externalRef: issueKey ? jiraIssueExternalRef(issueKey) : null,
    issueKey,
    self: typeof issue?.self === "string" ? issue.self : null,
    canonical: jiraCanonicalTransition({
      webhookEvent: payload.webhookEvent ?? "",
      statusCategoryKey: fields?.status?.statusCategory?.key ?? null,
      resolutionName: fields?.resolution?.name ?? null,
      sprintRemoved: sprintRemovedFromChangelog(payload),
    }),
  };
}

/** Parse a pasted Jira issue URL into its key, e.g.
 *  https://acme.atlassian.net/browse/ORB-42 -> { key: "ORB-42" }. */
export function parseJiraIssueUrl(url: string): { key: string } | null {
  const m = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/.exec(url.trim());
  return m ? { key: m[1] } : null;
}
