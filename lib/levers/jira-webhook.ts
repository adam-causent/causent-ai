// Jira webhook processing (#19) — the parallel of lib/levers/webhook.ts for Jira.
// Verify (shared secret) + dedup + detect, injected client so it is exercised
// with SYNTHETIC payloads and zero live Jira. The thin route
// (app/api/webhooks/jira/route.ts) only reads the raw body + secret header.
//
// Same invariants as the GitHub path: the (source, provider_event_id) dedup
// insert is the FIRST write, so a redelivered event returns early WITHOUT
// re-detecting — the unique index is the idempotency authority. Jira has no
// per-delivery id header, so provider_event_id is composed deterministically from
// (issue id, webhookEvent, timestamp): the same event redelivered dedups.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseJiraEvent,
  verifyJiraSecret,
  type JiraWebhookPayload,
  type ParsedJiraEvent,
} from "../connectors/jira.ts";
import { detectLever } from "./detect.ts";

const UNIQUE_VIOLATION = "23505";

export type JiraWebhookParams = {
  rawBody: string;
  /** The secret the caller presented (header/query); compared to `secret`. */
  providedSecret: string | null;
  secret: string;
  nowIso?: string;
};

export type JiraWebhookOutcome = {
  status: number;
  result:
    | "detected"
    | "duplicate"
    | "ignored_no_provenance"
    | "ignored_no_lever"
    | "ignored_untracked_action"
    | "invalid_secret"
    | "bad_request";
  leverId?: string;
};

/** Deterministic dedup key: (issue id, event, timestamp). A redelivery of the
 *  exact same Jira event produces the same id and conflicts on the unique index. */
function jiraEventId(payload: JiraWebhookPayload, event: ParsedJiraEvent): string {
  const id = payload.issue?.id ?? event.issueKey ?? "unknown";
  const ts = payload.timestamp ?? "";
  return `jira:${id}:${payload.webhookEvent ?? "?"}:${ts}`;
}

export async function processJiraWebhook(
  sb: SupabaseClient,
  params: JiraWebhookParams,
): Promise<JiraWebhookOutcome> {
  if (!verifyJiraSecret(params.secret, params.providedSecret)) {
    return { status: 401, result: "invalid_secret" };
  }

  let payload: JiraWebhookPayload;
  try {
    payload = JSON.parse(params.rawBody) as JiraWebhookPayload;
  } catch {
    return { status: 400, result: "bad_request" };
  }

  const event = parseJiraEvent(payload);
  if (!event.token || !event.canonical || !event.externalRef) {
    return { status: 200, result: "ignored_no_provenance" };
  }

  const leverRes = await sb
    .from("levers")
    .select("lever_id, action_id")
    .eq("provenance_token", event.token)
    .maybeSingle();
  if (leverRes.error) return { status: 500, result: "bad_request" };
  if (!leverRes.data) return { status: 200, result: "ignored_no_lever" };
  const lever = leverRes.data as { lever_id: string; action_id: string };

  const nowIso = params.nowIso ?? new Date().toISOString();

  // Dedup FIRST (unique (source, provider_event_id)).
  const txn = await sb.from("transition_events").insert({
    action_id: lever.action_id,
    canonical: event.canonical,
    source: "jira",
    provider_event_id: jiraEventId(payload, event),
    transition_ts: nowIso,
    to_status: payload.webhookEvent ?? null,
    raw_payload: payload as unknown as Record<string, unknown>,
  });
  if (txn.error) {
    if (txn.error.code === UNIQUE_VIOLATION) return { status: 200, result: "duplicate" };
    return { status: 500, result: "bad_request" };
  }

  // Attribute on the issue coming to life. SHIPPED/DROPPED are recorded above;
  // their lifecycle handling is C5, not #19.
  if (event.canonical === "LEVER_ACTIVE") {
    const det = await detectLever(sb, {
      token: event.token,
      externalRef: event.externalRef,
      htmlUrl: event.self,
      detectedAt: nowIso,
    });
    if (!det.ok) return { status: 200, result: "ignored_no_lever" };
    return { status: 200, result: "detected", leverId: det.leverId };
  }

  return { status: 200, result: "ignored_untracked_action", leverId: lever.lever_id };
}
