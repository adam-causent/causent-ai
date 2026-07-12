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
  lift: number | null;
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
      .select("edge_id, lift, created_at, evidence_id")
      .eq("scope_id", DEMO_SCOPE_ID)
      .eq("methodology", "ITS"),
  ]);

  if (nodesRes.error) throw nodesRes.error;
  if (edgesRes.error) throw edgesRes.error;
  if (evidenceRes.error) throw evidenceRes.error;

  const nodes = (nodesRes.data ?? []) as NodeRow[];
  const edges = (edgesRes.data ?? []) as EdgeRow[];
  const evidence = (evidenceRes.data ?? []) as EvidenceRow[];

  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));

  // Latest authoritative ITS lift per edge (evidence is append-only: a re-run adds a
  // fresh row, so we take the newest by created_at, tie-broken by evidence_id —
  // exactly the bridge/E2E ordering).
  const latestIts = new Map<string, EvidenceRow>();
  for (const ev of evidence) {
    const prev = latestIts.get(ev.edge_id);
    if (
      !prev ||
      ev.created_at > prev.created_at ||
      (ev.created_at === prev.created_at && ev.evidence_id > prev.evidence_id)
    ) {
      latestIts.set(ev.edge_id, ev);
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
    const its = latestIts.get(edge.edge_id);
    out.set(edgeKey(source.semantic_ref, target.semantic_ref), {
      actionId: source.semantic_ref,
      metricId: target.semantic_ref,
      dbDirection: edge.direction,
      beliefScore: edge.belief_score === null ? null : Number(edge.belief_score),
      beliefReason: edge.belief_reason,
      lift: its?.lift == null ? null : Number(its.lift),
    });
  }
  return out;
});
