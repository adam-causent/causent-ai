// GitHub connector — PURE core for the create-from-decision lever flow (#16).
//
// Like lib/ingest/github.ts this file is PURE: no network, no env, no `@/`
// imports, no DB. It is the deep-link builder + the provenance/canonical maps +
// the webhook verify/parse — everything that can be exercised against synthetic
// inputs with zero credentials. The DB writes live in lib/levers/*; the HTTP
// adapters live in the route handlers.
//
// Provenance (locked A3): ONE detector, two strategies in order —
//   1. the GitHub label  causent-decision-<decisionId>  (both the write path and
//      the read-only deep-link path attach it), then
//   2. a description/token scan for the same token (the deep-link body carries it
//      too, in case the label was stripped).
// The token IS the label string; it is the levers.provenance_token idempotency
// key. Detection is idempotent on it.

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Provenance token / label.
// ---------------------------------------------------------------------------

/** The provenance label + token for a decision: `causent-decision-<id>`. This
 *  exact string is the GitHub label, the body marker, AND levers.provenance_token. */
export function provenanceToken(decisionId: string): string {
  return `causent-decision-${decisionId}`;
}

/** Extract a decision id from a provenance token, or null if it isn't one. */
export function decisionIdFromToken(token: string): string | null {
  const m = /^causent-decision-(.+)$/.exec(token.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Deep-link builder (read-only default path — the user creates the issue).
// ---------------------------------------------------------------------------

export interface DeepLinkParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  decisionId: string;
}

/**
 * The prefilled `issues/new` URL. The user clicks it, GitHub opens the new-issue
 * form with title/body/label filled, and they submit in THEIR repo — Causent
 * needs no write scope. The label carries the provenance token so the webhook /
 * poll can attribute the created issue back to the decision. The body embeds the
 * token too (strategy 2), so attribution survives a stripped label.
 */
export function buildIssueDeepLink(params: DeepLinkParams): string {
  const token = provenanceToken(params.decisionId);
  const body = `${params.body}\n\n<!-- ${token} -->`;
  const qs = new URLSearchParams({
    title: params.title,
    body,
    labels: token,
  });
  return `https://github.com/${params.owner}/${params.repo}/issues/new?${qs.toString()}`;
}

/** Stable external_ref for a detected GitHub issue (matches lib/ingest's scheme). */
export function issueExternalRef(issueNumber: number): string {
  return `github:issue:${issueNumber}`;
}

// ---------------------------------------------------------------------------
// Canonical transition map (GitHub issue event -> transition_events.canonical).
// ---------------------------------------------------------------------------

export type Canonical = "LEVER_ACTIVE" | "LEVER_SHIPPED" | "LEVER_DROPPED";

/**
 * Map a GitHub `issues` webhook (action + optional state_reason) to the canonical
 * transition the schema stores. `opened`/`reopened` → the lever is now live
 * (ACTIVE = detected); `closed` as `completed` → SHIPPED; `closed` as
 * `not_planned` → DROPPED (the drop is the drift signal). Returns null for
 * actions we don't track (labeled, assigned, edited, …).
 */
export function canonicalTransition(
  action: string,
  stateReason?: string | null,
): Canonical | null {
  switch (action) {
    case "opened":
    case "reopened":
      return "LEVER_ACTIVE";
    case "closed":
      return stateReason === "not_planned" ? "LEVER_DROPPED" : "LEVER_SHIPPED";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification (GitHub X-Hub-Signature-256, HMAC-SHA256).
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub webhook signature. `signatureHeader` is the raw
 * `X-Hub-Signature-256` value (`sha256=<hex>`). Constant-time compare; any
 * malformed/missing input is a rejection (never throws). This is what keeps the
 * unauthenticated webhook route from accepting forged payloads.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Webhook payload parsing (narrow, defensive — the body is untrusted).
// ---------------------------------------------------------------------------

/** The narrow subset of a GitHub `issues` webhook we read. */
export interface IssueWebhookPayload {
  action?: string;
  issue?: {
    number?: number;
    html_url?: string;
    state?: string;
    state_reason?: string | null;
    body?: string | null;
    labels?: Array<{ name?: string } | string> | null;
  } | null;
}

export interface ParsedIssueEvent {
  /** The decision this issue is a lever for, via label (strategy 1) or body
   *  token (strategy 2). null when the issue carries no Causent provenance. */
  decisionId: string | null;
  /** The provenance token (== the label), when found. */
  token: string | null;
  /** github:issue:<number>, when the issue has a number. */
  externalRef: string | null;
  htmlUrl: string | null;
  issueNumber: number | null;
  canonical: Canonical | null;
}

function labelNames(
  labels: Array<{ name?: string } | string> | null | undefined,
): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n): n is string => typeof n === "string");
}

/** Find the provenance token in the labels (strategy 1) or the body (strategy 2). */
export function findProvenance(
  labels: string[],
  body: string | null | undefined,
): { token: string; decisionId: string } | null {
  for (const name of labels) {
    const id = decisionIdFromToken(name);
    if (id) return { token: name, decisionId: id };
  }
  if (typeof body === "string") {
    const m = /causent-decision-([0-9a-fA-F-]{36})/.exec(body);
    if (m) return { token: `causent-decision-${m[1]}`, decisionId: m[1] };
  }
  return null;
}

/** Parse an `issues` webhook body into the normalized detection event. */
export function parseIssueEvent(payload: IssueWebhookPayload): ParsedIssueEvent {
  const issue = payload.issue ?? null;
  const labels = labelNames(issue?.labels);
  const prov = findProvenance(labels, issue?.body);
  const issueNumber = typeof issue?.number === "number" ? issue.number : null;
  return {
    decisionId: prov?.decisionId ?? null,
    token: prov?.token ?? null,
    externalRef: issueNumber != null ? issueExternalRef(issueNumber) : null,
    htmlUrl: typeof issue?.html_url === "string" ? issue.html_url : null,
    issueNumber,
    canonical: canonicalTransition(payload.action ?? "", issue?.state_reason ?? null),
  };
}
