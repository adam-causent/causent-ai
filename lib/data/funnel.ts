// Funnel instrumentation — the IO half (C2/#15, C5/#18).
//
// The Supabase client is INJECTED (same pattern as lib/onboarding/commit.ts) so
// the writer runs under the app's server client AND under an integration test's
// own client, and the module stays importable outside the Next runtime. The
// server clock stamps created_at (never hand-picked); the caller supplies only
// the client-measured ms_since_start.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeFunnelMetrics,
  type FunnelEventRow,
  type FunnelEventType,
  type FunnelMetrics,
} from "../funnel/events.ts";

export type RecordFunnelEventInput = {
  sessionKey: string;
  eventType: FunnelEventType;
  step?: string | null;
  msSinceStart?: number | null;
  meta?: Record<string, unknown> | null;
};

/** Append one funnel event. Best-effort by contract: instrumentation must never
 *  break the funnel, so callers ignore the boolean — but we return it for tests. */
export async function recordFunnelEvent(
  sb: SupabaseClient,
  scopeId: string,
  userId: string | null,
  input: RecordFunnelEventInput,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await sb.from("funnel_events").insert({
    scope_id: scopeId,
    user_id: userId,
    session_key: input.sessionKey,
    event_type: input.eventType,
    step: input.step ?? null,
    ms_since_start:
      typeof input.msSinceStart === "number" && Number.isFinite(input.msSinceStart)
        ? Math.round(input.msSinceStart)
        : null,
    meta: input.meta ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Resolution-return rate (#18): of the scope's RESOLVED predictions, the
 *  fraction whose scorecard has been viewed at least once. Prediction-keyed (via
 *  SCORECARD_VIEW meta.prediction_id) so it survives across browser sessions —
 *  distinct from computeFunnelMetrics' funnel-session return rate. Returns null
 *  when nothing has resolved yet. */
export async function getResolutionReturnRate(
  sb: SupabaseClient,
  scopeId: string,
): Promise<{ resolved: number; returned: number; rate: number | null }> {
  const [resolvedRes, viewsRes] = await Promise.all([
    sb
      .from("predictions")
      .select("prediction_id", { count: "exact", head: true })
      .eq("scope_id", scopeId)
      .not("resolved_at", "is", null),
    sb
      .from("funnel_events")
      .select("meta")
      .eq("scope_id", scopeId)
      .eq("event_type", "SCORECARD_VIEW"),
  ]);
  if (viewsRes.error) throw viewsRes.error;
  const resolved = resolvedRes.count ?? 0;
  const viewed = new Set<string>();
  for (const r of (viewsRes.data ?? []) as Array<{ meta: { prediction_id?: string } | null }>) {
    const pid = r.meta?.prediction_id;
    if (pid) viewed.add(pid);
  }
  return {
    resolved,
    returned: viewed.size,
    rate: resolved === 0 ? null : viewed.size / resolved,
  };
}

/** Read the scope's funnel events and fold them into the DoD metrics. */
export async function getFunnelMetrics(
  sb: SupabaseClient,
  scopeId: string,
): Promise<FunnelMetrics> {
  const { data, error } = await sb
    .from("funnel_events")
    .select("session_key, event_type, step, ms_since_start")
    .eq("scope_id", scopeId);
  if (error) throw error;
  const rows: FunnelEventRow[] = (
    (data ?? []) as Array<{
      session_key: string;
      event_type: FunnelEventType;
      step: string | null;
      ms_since_start: number | null;
    }>
  ).map((r) => ({
    sessionKey: r.session_key,
    eventType: r.event_type,
    step: r.step,
    msSinceStart: r.ms_since_start,
  }));
  return computeFunnelMetrics(rows);
}
