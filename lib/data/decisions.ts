// getDecisions() — the intent layer, mapped from the `decisions` +
// `decision_actions` + `predictions` (+ revisions) tables to lib/types.ts
// Decision. Mirrors lib/seed.ts `decisions`. Newest first.

import type { Decision, DriftReadout, Prediction, PredictionVerdict } from "@/lib/types";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID, METRIC_CONFIG_BY_NAME } from "@/lib/data/config";
import { getDriftByPrediction } from "@/lib/data/drift";

type RationaleDoc = {
  content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  meta?: { mechanism_category?: string };
};

type RevisionRow = {
  old_magnitude: number | null;
  new_magnitude: number | null;
  reason: string;
  revised_at: string;
};

type PredictionRow = {
  prediction_id: string;
  direction: "POSITIVE" | "NEGATIVE";
  magnitude_pct_mean: number;
  resolution_date: string;
  committed_at: string;
  resolved_verdict: string | null;
  resolved_at: string | null;
  resolution_tuple: { measured_pct?: number | null } | null;
  metric: { name: string } | null;
  prediction_revisions: RevisionRow[];
};

type DecisionRow = {
  decision_id: string;
  title: string;
  rationale: RationaleDoc | null;
  created_at: string;
  decision_actions: Array<{ action_id: string }>;
  // An action is a lever iff it has a levers row (C1/#14).
  levers: Array<{ action_id: string; status: string }>;
  predictions: PredictionRow[];
};

function paragraphs(doc: RationaleDoc | null): string[] {
  if (!doc?.content) return [];
  const out: string[] = [];
  for (const block of doc.content) {
    if (block.type !== "paragraph" || !block.content) continue;
    const text = block.content
      .map((n) => (n.type === "text" ? (n.text ?? "") : ""))
      .join("")
      .trim();
    if (text) out.push(text);
  }
  return out;
}

function mapPrediction(
  row: PredictionRow,
  driftByPrediction: Map<string, DriftReadout>,
): Prediction {
  const metricName = row.metric?.name ?? "";
  const measured = row.resolution_tuple?.measured_pct;
  return {
    id: row.prediction_id,
    metricId: METRIC_CONFIG_BY_NAME[metricName]?.id ?? metricName,
    direction: row.direction,
    magnitudePctMean: row.magnitude_pct_mean,
    resolutionDate: row.resolution_date,
    committedAt: row.committed_at.slice(0, 10),
    verdict: (row.resolved_verdict as PredictionVerdict | null) ?? null,
    resolvedAt: row.resolved_at ? row.resolved_at.slice(0, 10) : null,
    measuredPct: typeof measured === "number" ? measured : null,
    // Baseline drift, computed on read (empty map when the engine is unavailable).
    drift: driftByPrediction.get(row.prediction_id) ?? null,
    revisions: row.prediction_revisions
      .map((r) => ({
        oldMagnitudePct: r.old_magnitude ?? 0,
        newMagnitudePct: r.new_magnitude ?? 0,
        reason: r.reason,
        revisedAt: r.revised_at.slice(0, 10),
      }))
      .sort((a, b) => (a.revisedAt < b.revisedAt ? -1 : 1)),
  };
}

/** All decisions in the demo scope, newest first, actions mapped to UI ids. */
export async function getDecisions(): Promise<Decision[]> {
  const sb = await getServerSupabase();

  const [decisionsRes, actionsRes, driftByPrediction] = await Promise.all([
    sb
      .from("decisions")
      .select(
        "decision_id, title, rationale, created_at, " +
          "decision_actions(action_id), levers(action_id, status), " +
          "predictions(prediction_id, direction, magnitude_pct_mean, resolution_date, " +
          "committed_at, resolved_verdict, resolved_at, resolution_tuple, " +
          "metric:metrics(name), prediction_revisions(old_magnitude, new_magnitude, reason, revised_at))",
      )
      .eq("scope_id", DEMO_SCOPE_ID)
      .order("created_at", { ascending: false }),
    // uuid -> UI "a-<pr>" id map (same derivation as lib/data/actions.ts).
    sb.from("actions").select("action_id, external_ref").eq("scope_id", DEMO_SCOPE_ID),
    // Baseline drift, computed on read through the engine (empty on any failure).
    getDriftByPrediction(),
  ]);
  if (decisionsRes.error) throw decisionsRes.error;
  if (actionsRes.error) throw actionsRes.error;

  const uiIdByUuid = new Map(
    (actionsRes.data as Array<{ action_id: string; external_ref: string | null }>).map(
      (a) => {
        const m = a.external_ref?.match(/(\d+)/);
        return [a.action_id, m ? `a-${m[1]}` : a.action_id] as const;
      },
    ),
  );

  return (decisionsRes.data as unknown as DecisionRow[]).map((row) => {
    const lever = row.levers[0] ?? null;
    return {
      id: row.decision_id,
      title: row.title,
      createdAt: row.created_at.slice(0, 10),
      rationale: {
        body: paragraphs(row.rationale),
        mechanismCategory: row.rationale?.meta?.mechanism_category,
      },
      actionIds: row.decision_actions.map(
        (da) => uiIdByUuid.get(da.action_id) ?? da.action_id,
      ),
      leverActionId: lever ? (uiIdByUuid.get(lever.action_id) ?? lever.action_id) : null,
      predictions: row.predictions.map((p) => mapPrediction(p, driftByPrediction)),
    };
  });
}
