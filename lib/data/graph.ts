// Loads the materialized decision graph (nodes + causal_edges + the authoritative
// ITS evidence) and joins it into one lookup: per (action, metric) the engine's
// direction, belief, and the ITS lift magnitude. lib/data/actions.ts and
// lib/data/impact.ts both build on this so the graph is fetched and joined once.
//
// nodes is polymorphic (nodes.semantic_ref = action_id | metric_id | cluster_id with
// no FK), so PostgREST can't auto-join edges to actions/metrics. We fetch nodes,
// edges, and evidence flat and stitch them in TS by node_id / semantic_ref.

import { cache } from "react";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID } from "@/lib/data/config";

/** One materialized ACTION -> METRIC readout, already joined to its ITS lift. */
export type EdgeReadout = {
  actionId: string;
  metricId: string;
  /** Raw engine direction: 'POSITIVE' | 'NEGATIVE' | 'INCONCLUSIVE'. */
  dbDirection: string;
  /** 0..1, or null when belief is withheld ("we don't know"). */
  beliefScore: number | null;
  /** Why belief was withheld/demoted (INSUFFICIENT_HISTORY, FDR_DEMOTED, …) or null. */
  beliefReason: string | null;
  /** Step estimate from the latest authoritative ITS evidence row (native units). */
  lift: number | null;
  /** Non-authoritative 14-day before/after mean shift, when evaluable. */
  descriptiveLift: number | null;
  descriptiveCiLow: number | null;
  descriptiveCiHigh: number | null;
  /** True when another action's 14-day window overlaps this action. */
  descriptiveClustered: boolean;
};

type NodeRow = { node_id: string; type: string; semantic_ref: string };
type EdgeRow = {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: string;
  belief_score: number | null;
  belief_reason: string | null;
};
type EvidenceRow = {
  edge_id: string;
  methodology: string;
  lift: number | null;
  ci_low: number | null;
  ci_high: number | null;
  clustered: boolean;
  created_at: string;
  evidence_id: string;
};

/** Composite key for the (action, metric) lookup. */
export function edgeKey(actionId: string, metricId: string): string {
  return `${actionId}::${metricId}`;
}

/**
 * All ACTION -> METRIC readouts in the demo scope, keyed by edgeKey(actionId, metricId).
 * CLUSTER edges are intentionally dropped here — the UI reads per action, and clusters
 * are an overlay (see engine/persistence/bridge.py). Read-only; never mutates the graph.
 */
export const loadEdgeReadouts = cache(async function loadEdgeReadouts(): Promise<
  Map<string, EdgeReadout>
> {
  const sb = await getServerSupabase();

  const [nodesRes, edgesRes, evidenceRes] = await Promise.all([
    sb
      .from("nodes")
      .select("node_id, type, semantic_ref")
      .eq("scope_id", DEMO_SCOPE_ID),
    sb
      .from("causal_edges")
      .select("edge_id, source_node_id, target_node_id, direction, belief_score, belief_reason")
      .eq("scope_id", DEMO_SCOPE_ID),
    sb
      .from("evidence_objects")
      .select("edge_id, methodology, lift, ci_low, ci_high, clustered, created_at, evidence_id")
      .eq("scope_id", DEMO_SCOPE_ID)
      .in("methodology", ["ITS", "BEFORE_AFTER_14D"]),
  ]);

  if (nodesRes.error) throw nodesRes.error;
  if (edgesRes.error) throw edgesRes.error;
  if (evidenceRes.error) throw evidenceRes.error;

  const nodes = (nodesRes.data ?? []) as NodeRow[];
  const edges = (edgesRes.data ?? []) as EdgeRow[];
  const evidence = (evidenceRes.data ?? []) as EvidenceRow[];

  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));

  // Evidence is append-only. Keep the newest row for each edge + method, ordered
  // by created_at then evidence_id exactly like the bridge/E2E contract.
  const latestByMethod = new Map<string, EvidenceRow>();
  for (const ev of evidence) {
    const key = `${ev.edge_id}::${ev.methodology}`;
    const prev = latestByMethod.get(key);
    if (
      !prev ||
      ev.created_at > prev.created_at ||
      (ev.created_at === prev.created_at && ev.evidence_id > prev.evidence_id)
    ) {
      latestByMethod.set(key, ev);
    }
  }

  const out = new Map<string, EdgeReadout>();
  for (const edge of edges) {
    const source = nodeById.get(edge.source_node_id);
    const target = nodeById.get(edge.target_node_id);
    // ACTION -> METRIC only; skip CLUSTER sources and any dangling node ref.
    if (!source || !target || source.type !== "ACTION" || target.type !== "METRIC") {
      continue;
    }
    const its = latestByMethod.get(`${edge.edge_id}::ITS`);
    const descriptive = latestByMethod.get(`${edge.edge_id}::BEFORE_AFTER_14D`);
    out.set(edgeKey(source.semantic_ref, target.semantic_ref), {
      actionId: source.semantic_ref,
      metricId: target.semantic_ref,
      dbDirection: edge.direction,
      beliefScore: edge.belief_score === null ? null : Number(edge.belief_score),
      beliefReason: edge.belief_reason,
      lift: its?.lift == null ? null : Number(its.lift),
      descriptiveLift:
        descriptive?.lift == null ? null : Number(descriptive.lift),
      descriptiveCiLow:
        descriptive?.ci_low == null ? null : Number(descriptive.ci_low),
      descriptiveCiHigh:
        descriptive?.ci_high == null ? null : Number(descriptive.ci_high),
      descriptiveClustered: descriptive?.clustered ?? false,
    });
  }
  return out;
});
