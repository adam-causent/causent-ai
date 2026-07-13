"use server";

// Server actions for the Actions & Decisions tab (epic #6, #10).
//
// Trust model: writes run through the pinned demo-scope server client, exactly
// like today's reads (see DEMO_SCOPE_ID's TODO(auth) — an RLS-scoped user
// client replaces this when SEC2 lands). Validation is the PURE lib
// (lib/predictions.ts); this file only maps ids and persists.
//
// Elicit-not-assert, structurally: no action here computes, suggests, or
// pre-fills a magnitude. proposeLever() suggests WHICH TICKET carries the
// mechanism (a mapping hint the human confirms) — never a number. The LLM
// version of that proposal is a deliberate later seam (mirrors lib/summary's
// off-by-default polish): today's heuristic is deterministic.

import { revalidatePath } from "next/cache";
import { spawn } from "node:child_process";
import path from "node:path";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID, METRIC_CONFIG_BY_SLUG } from "@/lib/data/config";
import { getPriorsForReferenceClass } from "@/lib/data/priors";
import type { ReferenceClassPriors } from "@/lib/priors";
import {
  validatePrediction,
  validateRevision,
  type PredictionInput,
} from "@/lib/predictions";

type ActionResult = { ok: true } | { ok: false; errors: string[] };

/** UI "a-<pr>" id -> DB action row (via external_ref, as lib/data maps it). */
async function actionRow(
  uiId: string,
): Promise<{ action_id: string; source: string; effective_date: string | null } | null> {
  const pr = uiId.match(/^a-(\d+)$/)?.[1];
  if (!pr) return null;
  const sb = await getServerSupabase();
  const res = await sb
    .from("actions")
    .select("action_id, source, effective_date")
    .eq("scope_id", DEMO_SCOPE_ID)
    .eq("external_ref", `PR #${pr}`)
    .maybeSingle();
  if (res.error) throw res.error;
  return (
    (res.data as {
      action_id: string;
      source: string;
      effective_date: string | null;
    } | null) ?? null
  );
}

/** UI metric slug -> DB metric uuid (via the canonical name mapping). */
async function metricUuid(slug: string): Promise<string | null> {
  const name = METRIC_CONFIG_BY_SLUG[slug]?.name;
  if (!name) return null;
  const sb = await getServerSupabase();
  const res = await sb
    .from("metrics")
    .select("metric_id")
    .eq("scope_id", DEMO_SCOPE_ID)
    .eq("name", name)
    .maybeSingle();
  if (res.error) throw res.error;
  return (res.data as { metric_id: string } | null)?.metric_id ?? null;
}

/**
 * The capture flow's one write: decision + (optional single) lever mapping +
 * the team's pre-registered prediction, atomically enough for v1 (decision
 * first; on later failure the decision row is inert, not wrong).
 */
export async function createDecisionWithPrediction(input: {
  title: string;
  why: string;
  mechanismCategory: string;
  prediction: PredictionInput;
}): Promise<ActionResult> {
  const errors = validatePrediction(input.prediction);
  if (!input.title.trim()) errors.push("Give the decision a title.");
  if (errors.length > 0) return { ok: false, errors };

  const metricId = await metricUuid(input.prediction.metricId);
  if (!metricId) return { ok: false, errors: ["Unknown metric."] };
  const lever = input.prediction.leverActionId
    ? await actionRow(input.prediction.leverActionId)
    : null;
  if (input.prediction.leverActionId && !lever) {
    return { ok: false, errors: ["The selected lever action was not found."] };
  }

  const sb = await getServerSupabase();
  const rationale = {
    type: "doc",
    content: input.why.trim()
      ? [{ type: "paragraph", content: [{ type: "text", text: input.why.trim() }] }]
      : [],
    meta: { mechanism_category: input.mechanismCategory || null },
  };

  const decisionRes = await sb
    .from("decisions")
    .insert({ scope_id: DEMO_SCOPE_ID, title: input.title.trim(), rationale })
    .select("decision_id")
    .single();
  if (decisionRes.error) return { ok: false, errors: [decisionRes.error.message] };
  const decisionId = (decisionRes.data as { decision_id: string }).decision_id;

  if (lever) {
    const daRes = await sb.from("decision_actions").insert({
      decision_id: decisionId,
      action_id: lever.action_id,
    });
    if (daRes.error) return { ok: false, errors: [daRes.error.message] };
    // The lever mark lives in public.levers (C1/#14). This maps an EXISTING
    // action, so the draft->detect lifecycle is already past detection:
    // SHIPPED when the action has an effective (ship) date, else DETECTED.
    const leverRes = await sb.from("levers").insert({
      scope_id: DEMO_SCOPE_ID,
      decision_id: decisionId,
      action_id: lever.action_id,
      metric_id: metricId,
      provenance_token: `causent-${crypto.randomUUID()}`,
      target_source: lever.source === "jira" ? "jira" : "github",
      status: lever.effective_date ? "SHIPPED" : "DETECTED",
      detected_at: new Date().toISOString(),
    });
    if (leverRes.error) return { ok: false, errors: [leverRes.error.message] };
  }

  const predRes = await sb.from("predictions").insert({
    scope_id: DEMO_SCOPE_ID,
    decision_id: decisionId,
    metric_id: metricId,
    direction: input.prediction.direction,
    magnitude_pct_mean: input.prediction.magnitudePctMean,
    resolution_date: input.prediction.resolutionDate,
  });
  if (predRes.error) return { ok: false, errors: [predRes.error.message] };

  revalidatePath("/actions");
  return { ok: true };
}

/**
 * Revise a committed prediction — requires a logged reason (append-only
 * prediction_revisions), then updates the live magnitude. Terminal
 * predictions can't be revised (the record already resolved).
 */
export async function revisePrediction(input: {
  predictionId: string;
  newMagnitudePct: number;
  reason: string;
}): Promise<ActionResult> {
  const errors = validateRevision({
    newMagnitudePct: input.newMagnitudePct,
    reason: input.reason,
  });
  if (errors.length > 0) return { ok: false, errors };

  const sb = await getServerSupabase();
  const current = await sb
    .from("predictions")
    .select("magnitude_pct_mean, direction, resolved_at")
    .eq("prediction_id", input.predictionId)
    .maybeSingle();
  if (current.error) return { ok: false, errors: [current.error.message] };
  const row = current.data as {
    magnitude_pct_mean: number;
    direction: string;
    resolved_at: string | null;
  } | null;
  if (!row) return { ok: false, errors: ["Prediction not found."] };
  if (row.resolved_at !== null) {
    return { ok: false, errors: ["This prediction already resolved — the record stands."] };
  }

  const revRes = await sb.from("prediction_revisions").insert({
    prediction_id: input.predictionId,
    old_magnitude: row.magnitude_pct_mean,
    old_direction: row.direction,
    new_magnitude: input.newMagnitudePct,
    new_direction: row.direction,
    reason: input.reason.trim(),
  });
  if (revRes.error) return { ok: false, errors: [revRes.error.message] };

  const updRes = await sb
    .from("predictions")
    .update({ magnitude_pct_mean: input.newMagnitudePct })
    .eq("prediction_id", input.predictionId);
  if (updRes.error) return { ok: false, errors: [updRes.error.message] };

  revalidatePath("/actions");
  return { ok: true };
}

/** Precedent for the capture flow's reference class (never a suggested number). */
export async function fetchPriors(params: {
  metricSlug: string;
  mechanismCategory?: string | null;
}): Promise<ReferenceClassPriors> {
  const uuid = await metricUuid(params.metricSlug);
  if (!uuid) {
    return {
      hasPrecedent: false,
      supportCount: 0,
      verdictCounts: {},
      baseRate: { n: 0, weightedMeanPct: null, minPct: null, maxPct: null },
      calibration: { n: 0, weightedMeanErrorPct: null },
    };
  }
  return getPriorsForReferenceClass({
    metricId: uuid,
    mechanismCategory: params.mechanismCategory,
  });
}

/**
 * Deterministic lever proposal: among candidate actions, the one whose primary
 * metric matches the prediction's metric (ties -> newest ship). A mapping
 * HINT the human confirms — never auto-committed, never a magnitude.
 */
export async function proposeLever(params: {
  metricSlug: string;
  candidates: Array<{ id: string; primaryMetricId: string; shippedAt: string | null }>;
}): Promise<{ suggestedActionId: string | null }> {
  const matches = params.candidates
    .filter((c) => c.primaryMetricId === params.metricSlug)
    .sort((a, b) => ((a.shippedAt ?? "") < (b.shippedAt ?? "") ? 1 : -1));
  return { suggestedActionId: matches[0]?.id ?? null };
}

/**
 * Dev "Resolve now": runs the resolution CLI (engine/persistence/
 * run_resolution.py) over the demo scope. The cron sweep is Tranche 3; this is
 * the manual path the spec calls for. Fails honestly when the engine env is
 * not available (e.g. a deploy without the Python toolchain).
 */
export async function resolveNow(): Promise<ActionResult> {
  if (process.env.NODE_ENV === "production" && !process.env.CAUSENT_ALLOW_RESOLVE_NOW) {
    return { ok: false, errors: ["Resolve-now is a dev affordance; the scheduled sweep lands with the drift detector."] };
  }
  const engineDir = process.env.CAUSENT_ENGINE_DIR ?? path.join(process.cwd(), "engine");
  const python =
    process.env.CAUSENT_ENGINE_PYTHON ?? path.join(engineDir, ".venv", "bin", "python");
  const today = process.env.CAUSENT_DEMO_TODAY; // demo data lives in the past

  const args = [path.join("persistence", "run_resolution.py")];
  if (today) args.push("--today", today);

  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(python, args, { cwd: engineDir });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: null, out: String(err) }));
    child.on("close", (code) => resolve({ code, out }));
  });

  if (result.code !== 0) {
    return {
      ok: false,
      errors: [
        "Resolution runner unavailable or failed — run it from the CLI instead: cd engine && .venv/bin/python persistence/run_resolution.py",
        result.out.split("\n").slice(-3).join("\n"),
      ],
    };
  }
  revalidatePath("/actions");
  return { ok: true };
}
