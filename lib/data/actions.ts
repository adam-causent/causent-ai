// getActions() — shipped actions (merged GitHub PRs) with their per-metric honest
// impact cells, mapped from Supabase to lib/types.ts Action. Mirrors lib/seed.ts
// `actions`. Impact cells come from the materialized causal_edges/evidence via
// lib/data/graph.ts + lib/data/readout.ts — never hand-authored.

import type { Action, ImpactCell } from "@/lib/types";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID, METRIC_CONFIG_BY_NAME } from "@/lib/data/config";
import { getMetricRecords } from "@/lib/data/metrics";
import { edgeKey, loadEdgeReadouts } from "@/lib/data/graph";
import { toImpactCell } from "@/lib/data/readout";

type ActionRow = {
  action_id: string;
  external_ref: string | null;
  ship_ts: string | null;
  effective_date: string | null;
  status: string | null;
  rationale_richtext: RationaleDoc | null;
};

/** TipTap-ish doc stored in actions.rationale_richtext (see seed_demo.py _rationale). */
type RationaleDoc = {
  type?: string;
  title?: string;
  content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  meta?: { expected_metric?: string };
};

/** "PR #8421" -> 8421; null/garbage -> 0. */
function parsePr(externalRef: string | null): number {
  const m = externalRef?.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Flatten a rationale doc's paragraphs into plain-text lines. */
function paragraphs(doc: RationaleDoc | null): string[] {
  if (!doc?.content) return [];
  const out: string[] = [];
  for (const block of doc.content) {
    if (block.type !== "paragraph" || !block.content) continue;
    const text = block.content
      .map((n) => (n.type === "text" ? n.text ?? "" : ""))
      .join("")
      .trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * All actions in the demo scope, newest ship date first (matches lib/seed.ts order),
 * each carrying an ImpactCell for every metric (canonical metric order). A cell shows
 * a number only where the engine made a confident causal claim; everything else is a
 * neutral "—" ("gathering data" / inconclusive).
 */
export async function getActions(): Promise<Action[]> {
  const sb = await getServerSupabase();

  const [actionsRes, records, edges] = await Promise.all([
    sb
      .from("actions")
      .select("action_id, external_ref, ship_ts, effective_date, status, rationale_richtext")
      .eq("scope_id", DEMO_SCOPE_ID)
      .order("effective_date", { ascending: false }),
    getMetricRecords(),
    loadEdgeReadouts(),
  ]);
  if (actionsRes.error) throw actionsRes.error;
  const actionRows = (actionsRes.data ?? []) as ActionRow[];

  const firstMetricSlug = records[0]?.metric.id ?? "arr";

  return actionRows.map((row) => {
    const pr = parsePr(row.external_ref);
    const doc = row.rationale_richtext;
    const body = paragraphs(doc);

    // Impact cells in canonical metric order; look up this action's edge per metric.
    const impact: ImpactCell[] = records.map((rec) =>
      toImpactCell(rec.metric, edges.get(edgeKey(row.action_id, rec.metricId))),
    );

    // Primary metric = the action's hypothesized target (rationale meta), by slug.
    const expectedName = doc?.meta?.expected_metric;
    const primaryMetricId =
      (expectedName && METRIC_CONFIG_BY_NAME[expectedName]?.id) || firstMetricSlug;

    const action: Action = {
      id: `a-${pr}`,
      pr,
      title: doc?.title ?? row.external_ref ?? `PR #${pr}`,
      shippedAt: row.effective_date ?? (row.ship_ts ? row.ship_ts.slice(0, 10) : null),
      primaryMetricId,
      impact,
    };

    if (body.length > 0) {
      action.rationale = {
        hypothesis: body[0],
        expectedMetricId: primaryMetricId,
        body,
      };
    }
    return action;
  });
}
