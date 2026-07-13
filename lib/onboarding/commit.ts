// The onboarding funnel's DB writes (C2/#15): declared-metric creation and the
// prediction commit. The Supabase client is INJECTED (like lib/ingest's store)
// so the same code runs under the app's server client and under the
// integration test's own client — and stays importable outside the Next
// runtime (no server-only import here; the server action supplies the client
// and the session scope).

import type { SupabaseClient } from "@supabase/supabase-js";
import { validatePrediction } from "../predictions.ts";

export type DeclareMetricResult = {
  metricId: string;
  name: string;
  /** true when an existing metric matched by name and no row was created. */
  reused: boolean;
  /** The metric's source as stored ('declared' for new funnel metrics). */
  source: string;
  /** Whether the metric has any observations (drives the precedent panel). */
  hasObservations: boolean;
};

/**
 * Resolve the metric a prediction commits against. If a metric with this name
 * already exists in the scope (case-insensitive), REUSE it — attaching the
 * prediction to a wired metric is strictly better than shadowing it with a
 * declared duplicate (and unlocks real precedent). Otherwise create exactly
 * one name-only row with source='declared' and no observations, so
 * predictions.metric_id (NOT NULL) is satisfiable before any connector exists.
 */
export async function declareMetric(
  sb: SupabaseClient,
  scopeId: string,
  rawName: string,
): Promise<DeclareMetricResult | { error: string }> {
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) return { error: "Name the metric this decision should move." };

  const existing = await sb
    .from("metrics")
    .select("metric_id, name, source, metric_observations(metric_id)")
    .eq("scope_id", scopeId)
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  if (existing.error) return { error: existing.error.message };
  if (existing.data) {
    const row = existing.data as {
      metric_id: string;
      name: string;
      source: string;
      metric_observations: Array<{ metric_id: string }>;
    };
    return {
      metricId: row.metric_id,
      name: row.name,
      reused: true,
      source: row.source,
      hasObservations: row.metric_observations.length > 0,
    };
  }

  const inserted = await sb
    .from("metrics")
    .insert({ scope_id: scopeId, name, source: "declared" })
    .select("metric_id")
    .single();
  if (inserted.error) return { error: inserted.error.message };
  return {
    metricId: (inserted.data as { metric_id: string }).metric_id,
    name,
    reused: false,
    source: "declared",
    hasObservations: false,
  };
}

export type CommitInput = {
  title: string;
  /** The named mechanism — the interrogation blocks commit until non-empty. */
  mechanismSummary: string;
  mechanismCategory: string;
  /** Optional extra context (answers to the interrogation questions). */
  notes: string[];
  metricId: string;
  direction: "POSITIVE" | "NEGATIVE";
  magnitudePctMean: number;
  resolutionDate: string;
};

export type CommitResult =
  | { ok: true; decisionId: string; predictionId: string }
  | { ok: false; errors: string[] };

/**
 * The Step-4 commit: one decisions row + one predictions row, scoped to the
 * session workspace. The prediction persists UNATTRIBUTED — no lever exists
 * yet (arming it is C3), so resolved_verdict stays NULL and, at resolution
 * time, the machine's no-lever path applies. Elicit-not-assert: everything
 * numeric here was typed by the team.
 */
export async function commitPrediction(
  sb: SupabaseClient,
  scopeId: string,
  input: CommitInput,
): Promise<CommitResult> {
  const errors = validatePrediction({
    metricId: input.metricId,
    direction: input.direction,
    magnitudePctMean: input.magnitudePctMean,
    resolutionDate: input.resolutionDate,
    leverActionId: null,
  });
  if (!input.title.trim()) errors.push("Give the decision a title.");
  if (!input.mechanismSummary.trim()) {
    errors.push("Name the mechanism — what changes, and why would that move the metric?");
  }
  if (errors.length > 0) return { ok: false, errors };

  const paragraphs = [input.mechanismSummary.trim(), ...input.notes]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }));
  const rationale = {
    type: "doc",
    content: paragraphs,
    meta: { mechanism_category: input.mechanismCategory || null },
  };

  const decisionRes = await sb
    .from("decisions")
    .insert({ scope_id: scopeId, title: input.title.trim(), rationale })
    .select("decision_id")
    .single();
  if (decisionRes.error) return { ok: false, errors: [decisionRes.error.message] };
  const decisionId = (decisionRes.data as { decision_id: string }).decision_id;

  const predRes = await sb
    .from("predictions")
    .insert({
      scope_id: scopeId,
      decision_id: decisionId,
      metric_id: input.metricId,
      direction: input.direction,
      magnitude_pct_mean: input.magnitudePctMean,
      resolution_date: input.resolutionDate,
    })
    .select("prediction_id")
    .single();
  if (predRes.error) return { ok: false, errors: [predRes.error.message] };

  return {
    ok: true,
    decisionId,
    predictionId: (predRes.data as { prediction_id: string }).prediction_id,
  };
}
