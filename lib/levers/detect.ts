// Lever detection + lifecycle (#16). The ONE detector both the webhook receiver
// and the manual paste-URL fallback call — attribution is identical no matter how
// the signal arrives. Injected client (testable).
//
// Detection is the attribution boundary: a DRAFTED/CREATED lever does NOT
// attribute its prediction; a DETECTED lever (external_ref set) does. Idempotent
// on the provenance token: a redelivered webhook or a re-pasted URL is a no-op.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Statuses at/after which a lever is considered attributed (detected). */
const DETECTED_OR_LATER = new Set(["DETECTED", "SHIPPED"]);

export type DetectInput = {
  /** The provenance token (== levers.provenance_token == the GitHub label). */
  token: string;
  /** github:issue:<n> — stamped onto the early actions row. */
  externalRef: string;
  /** The created issue's URL (stored on the lever payload for the UI). */
  htmlUrl?: string | null;
  /** Detection timestamp (ISO). Injected so tests are deterministic. */
  detectedAt?: string;
};

export type DetectResult =
  | { ok: true; leverId: string; actionId: string; alreadyDetected: boolean }
  | { ok: false; reason: "no_lever"; error?: string };

type LeverRow = {
  lever_id: string;
  action_id: string;
  status: string;
  drafted_payload: Record<string, unknown> | null;
};

/**
 * Attribute the lever identified by `token` to a real issue: set the early
 * actions row's external_ref, flip the lever to DETECTED, stamp detected_at.
 * Idempotent — if the lever is already DETECTED/SHIPPED it is left untouched.
 */
export async function detectLever(
  sb: SupabaseClient,
  input: DetectInput,
): Promise<DetectResult> {
  const found = await sb
    .from("levers")
    .select("lever_id, action_id, status, drafted_payload")
    .eq("provenance_token", input.token)
    .maybeSingle();
  if (found.error) return { ok: false, reason: "no_lever", error: found.error.message };
  if (!found.data) return { ok: false, reason: "no_lever" };
  const lever = found.data as LeverRow;

  if (DETECTED_OR_LATER.has(lever.status)) {
    return { ok: true, leverId: lever.lever_id, actionId: lever.action_id, alreadyDetected: true };
  }

  const detectedAt = input.detectedAt ?? new Date().toISOString();

  const actionUpd = await sb
    .from("actions")
    .update({ external_ref: input.externalRef })
    .eq("action_id", lever.action_id);
  if (actionUpd.error) {
    return { ok: false, reason: "no_lever", error: actionUpd.error.message };
  }

  const payload = { ...(lever.drafted_payload ?? {}), detected_url: input.htmlUrl ?? null };
  const leverUpd = await sb
    .from("levers")
    .update({ status: "DETECTED", detected_at: detectedAt, drafted_payload: payload })
    .eq("lever_id", lever.lever_id);
  if (leverUpd.error) return { ok: false, reason: "no_lever", error: leverUpd.error.message };

  return { ok: true, leverId: lever.lever_id, actionId: lever.action_id, alreadyDetected: false };
}

/** DRAFTED → CREATED when the user reports they created the issue (deep-link
 *  click / paste). Best-effort lifecycle marker; detection is what attributes. */
export async function markLeverCreated(
  sb: SupabaseClient,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await sb
    .from("levers")
    .update({ status: "CREATED" })
    .eq("provenance_token", token)
    .eq("status", "DRAFTED");
  if (res.error) return { ok: false, error: res.error.message };
  return { ok: true };
}

/** Default detection window before a stale draft times out (env-overridable). */
export const DEFAULT_LEVER_TIMEOUT_DAYS = 14;

/**
 * Time out stale drafts: levers still DRAFTED/CREATED older than `timeoutDays`
 * become TIMED_OUT (nudge the user to the paste fallback). `now` is injected.
 * Returns the timed-out lever ids.
 */
export async function timeoutStaleLevers(
  sb: SupabaseClient,
  scopeId: string,
  opts: { now: Date; timeoutDays?: number },
): Promise<{ ok: true; timedOut: string[] } | { ok: false; error: string }> {
  const timeoutDays = opts.timeoutDays ?? DEFAULT_LEVER_TIMEOUT_DAYS;
  const cutoff = new Date(opts.now.getTime() - timeoutDays * 86_400_000).toISOString();
  const res = await sb
    .from("levers")
    .update({ status: "TIMED_OUT" })
    .eq("scope_id", scopeId)
    .in("status", ["DRAFTED", "CREATED"])
    .lt("created_at", cutoff)
    .select("lever_id");
  if (res.error) return { ok: false, error: res.error.message };
  return { ok: true, timedOut: (res.data as Array<{ lever_id: string }>).map((r) => r.lever_id) };
}

// ---------------------------------------------------------------------------
// Paste-URL fallback: parse a pasted GitHub issue URL into an external_ref.
// ---------------------------------------------------------------------------

export type ParsedIssueUrl = { owner: string; repo: string; number: number };

/** Parse `https://github.com/<owner>/<repo>/issues/<n>` (trailing junk ok). */
export function parseIssueUrl(url: string): ParsedIssueUrl | null {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
