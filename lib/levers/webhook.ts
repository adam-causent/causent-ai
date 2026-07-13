// Webhook processing core (#16) — verify + dedup + detect, injected client so it
// is exercised with SYNTHETIC signed payloads and zero live GitHub App. The thin
// route (app/api/webhooks/github/route.ts) only reads the raw body + headers and
// hands them here.
//
// Order matters: the (source, provider_event_id) dedup insert is the FIRST write,
// so a redelivered event conflicts and returns early WITHOUT re-detecting — the
// unique index is the idempotency authority, not the detector.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseIssueEvent,
  verifyWebhookSignature,
  type IssueWebhookPayload,
} from "../connectors/github.ts";
import { detectLever } from "./detect.ts";

/** Postgres unique-violation SQLSTATE (the dedup backstop). */
const UNIQUE_VIOLATION = "23505";

export type WebhookParams = {
  rawBody: string;
  signature: string | null;
  deliveryId: string | null;
  secret: string;
  /** Injected clock (ISO) for transition_ts / detected_at. */
  nowIso?: string;
};

export type WebhookOutcome = {
  status: number;
  /** Machine-readable result for the route's JSON + the tests. */
  result:
    | "detected"
    | "duplicate"
    | "ignored_no_provenance"
    | "ignored_no_lever"
    | "ignored_untracked_action"
    | "invalid_signature"
    | "bad_request";
  leverId?: string;
};

/**
 * Verify a GitHub `issues` webhook, dedup it on (github, delivery_id), and — for
 * an issue that opened/reopened carrying Causent provenance — attribute the
 * matching lever. Everything else is a benign 200 ignore.
 */
export async function processIssueWebhook(
  sb: SupabaseClient,
  params: WebhookParams,
): Promise<WebhookOutcome> {
  if (!verifyWebhookSignature(params.secret, params.rawBody, params.signature)) {
    return { status: 401, result: "invalid_signature" };
  }
  if (!params.deliveryId) return { status: 400, result: "bad_request" };

  let payload: IssueWebhookPayload;
  try {
    payload = JSON.parse(params.rawBody) as IssueWebhookPayload;
  } catch {
    return { status: 400, result: "bad_request" };
  }

  const event = parseIssueEvent(payload);
  if (!event.token || !event.canonical || !event.externalRef) {
    return { status: 200, result: "ignored_no_provenance" };
  }

  // Resolve the lever (→ action_id) the transition + detection attach to.
  const leverRes = await sb
    .from("levers")
    .select("lever_id, action_id")
    .eq("provenance_token", event.token)
    .maybeSingle();
  if (leverRes.error) return { status: 500, result: "bad_request" };
  if (!leverRes.data) return { status: 200, result: "ignored_no_lever" };
  const lever = leverRes.data as { lever_id: string; action_id: string };

  const nowIso = params.nowIso ?? new Date().toISOString();

  // Dedup FIRST: the unique(source, provider_event_id) index makes a redelivery
  // a no-op. A conflict means we already processed this delivery.
  const txn = await sb.from("transition_events").insert({
    action_id: lever.action_id,
    canonical: event.canonical,
    source: "github",
    provider_event_id: params.deliveryId,
    transition_ts: nowIso,
    to_status: payload.action ?? null,
    raw_payload: payload as unknown as Record<string, unknown>,
  });
  if (txn.error) {
    if (txn.error.code === UNIQUE_VIOLATION) return { status: 200, result: "duplicate" };
    return { status: 500, result: "bad_request" };
  }

  // Attribute on the issue coming to life (opened/reopened). SHIPPED/DROPPED
  // transitions are recorded above but their lifecycle handling is C5, not #16.
  if (event.canonical === "LEVER_ACTIVE") {
    const det = await detectLever(sb, {
      token: event.token,
      externalRef: event.externalRef,
      htmlUrl: event.htmlUrl,
      detectedAt: nowIso,
    });
    if (!det.ok) return { status: 200, result: "ignored_no_lever" };
    return { status: 200, result: "detected", leverId: det.leverId };
  }

  return { status: 200, result: "ignored_untracked_action", leverId: lever.lever_id };
}
