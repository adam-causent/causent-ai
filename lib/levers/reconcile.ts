// Reconciliation core (#16) — the backstop for dropped webhooks + the draft
// timeout. Injected client AND injected poller, so the whole sweep is tested
// with the repo poll MOCKED (a real live poll needs the fine-grained PAT and is
// the credential-gated follow-up).
//
// For each still-open lever (DRAFTED/CREATED) the poller looks for the created
// issue by its provenance label; a hit is attributed through the SAME detector
// the webhook uses (idempotent, so a webhook + a poll never double-count). Then
// stale drafts past the timeout window flip to TIMED_OUT.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decisionIdFromToken, issueExternalRef } from "../connectors/github.ts";
import {
  detectLever,
  timeoutStaleLevers,
  DEFAULT_LEVER_TIMEOUT_DAYS,
} from "./detect.ts";

/** A hit from polling the watch-target repo for a provenance label. */
export type PolledIssue = { number: number; htmlUrl: string };

/** The poll seam: given a repo + provenance token, find the created issue (or
 *  null). The mock returns fixtures; the live impl (deferred) calls the GitHub
 *  search API with the fine-grained PAT. */
export interface LeverPoller {
  findIssueForToken(repo: string, token: string): Promise<PolledIssue | null>;
}

type OpenLever = {
  lever_id: string;
  provenance_token: string;
  target_ref: string | null;
  target_source: string | null;
};

export type ReconcileResult = {
  scanned: number;
  detected: string[];
  timedOut: string[];
};

/**
 * One reconciliation sweep over `scopeId`: poll every open lever's watch target
 * for its label, attribute any hits, then time out stale drafts. `now` +
 * `timeoutDays` are injected. Poll failures for one lever never abort the sweep.
 */
export async function reconcileLevers(
  sb: SupabaseClient,
  poller: LeverPoller,
  opts: { scopeId: string; now: Date; timeoutDays?: number },
): Promise<{ ok: true; result: ReconcileResult } | { ok: false; error: string }> {
  const openRes = await sb
    .from("levers")
    .select("lever_id, provenance_token, target_ref, target_source")
    .eq("scope_id", opts.scopeId)
    .in("status", ["DRAFTED", "CREATED"]);
  if (openRes.error) return { ok: false, error: openRes.error.message };
  const open = (openRes.data as OpenLever[]) ?? [];

  const detected: string[] = [];
  for (const lever of open) {
    // The live poll here understands GitHub only; a Jira lever is detected via
    // its webhook + the paste fallback (a Jira live-poll backstop is a follow-up).
    // The timeout sweep below is tracker-agnostic and still covers Jira drafts.
    if (lever.target_source && lever.target_source !== "github") continue;
    if (!lever.target_ref || !decisionIdFromToken(lever.provenance_token)) continue;
    let hit: PolledIssue | null = null;
    try {
      hit = await poller.findIssueForToken(lever.target_ref, lever.provenance_token);
    } catch {
      continue; // one repo's poll failing must not abort the sweep
    }
    if (!hit) continue;
    const det = await detectLever(sb, {
      token: lever.provenance_token,
      externalRef: issueExternalRef(hit.number),
      htmlUrl: hit.htmlUrl,
      detectedAt: opts.now.toISOString(),
    });
    if (det.ok && !det.alreadyDetected) detected.push(det.leverId);
  }

  // Stale drafts that never got created → TIMED_OUT (nudge to paste fallback).
  const timeout = await timeoutStaleLevers(sb, opts.scopeId, {
    now: opts.now,
    timeoutDays: opts.timeoutDays ?? DEFAULT_LEVER_TIMEOUT_DAYS,
  });
  if (!timeout.ok) return { ok: false, error: timeout.error };

  return {
    ok: true,
    result: { scanned: open.length, detected, timedOut: timeout.timedOut },
  };
}
