-- Bridge support — columns + idempotency keys the persistence bridge needs.
-- The bridge (engine/persistence/bridge.py) materializes one metric's readouts
-- into the decision graph; these are the schema affordances it upserts on.
-- RLS is untouched: new columns inherit their table's existing policies, and
-- unique indexes do not affect row visibility.

-- ============================================================================
-- METHODOLOGY — re-assert the CHECK admits ITS / BEFORE_AFTER_14D / MANUAL.
-- ============================================================================
-- methodology is a CHECK constraint (not a pg enum) that already covers these
-- three (see 20260703223627_v1_schema.sql). Re-asserting the canonical set here
-- is idempotent and makes any future drift fail loudly at migration time.

alter table public.evidence_objects
  drop constraint if exists evidence_objects_methodology_check;
alter table public.evidence_objects
  add constraint evidence_objects_methodology_check
  check (methodology in ('ITS','BEFORE_AFTER_14D','MANUAL'));

-- ============================================================================
-- NEW COLUMNS
-- ============================================================================
-- belief_reason: why an edge's belief was withheld/downgraded, projected from
-- the authoritative ITS readout's Belief.reason (nullable — a plain OK edge has
-- none). Mirrors causal.types.BeliefReason exactly.
alter table public.causal_edges
  add column belief_reason text
  check (
    belief_reason is null
    or belief_reason in ('PLACEBO','AUTOCORRELATION','INSUFFICIENT_HISTORY','DEGENERATE')
  );

-- p_value: the ITS step's two-sided HAC p-value — raw feedstock for the deferred
-- belief-learning model (nullable; only an OK ITS readout carries one). numeric,
-- not real: a strong step yields a p far below float4's ~1e-38 floor (which would
-- underflow), and numeric preserves the raw magnitude the learning loop wants.
alter table public.evidence_objects
  add column p_value numeric;

-- ============================================================================
-- IDEMPOTENCY KEYS  (natural keys the bridge upserts on via ON CONFLICT)
-- ============================================================================
-- A node is unique per (scope, type, semantic_ref); an edge per (source,target);
-- a cluster per (scope, metric, window). These let a re-run converge instead of
-- duplicating, which is what makes the graph materialization idempotent.
create unique index nodes_scope_type_ref_key
  on public.nodes (scope_id, type, semantic_ref);
create unique index causal_edges_source_target_key
  on public.causal_edges (source_node_id, target_node_id);
create unique index clusters_scope_metric_window_key
  on public.clusters (scope_id, metric_id, window_start, window_end);
