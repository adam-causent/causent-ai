"""The persistence bridge — server-side glue between the engine and Postgres.

The causal engine (engine/causal/*) is STATELESS PURE numpy: it holds no DB
credentials and never self-queries. This module is the only place that touches
the database. It takes an INJECTED, RLS-scoped psycopg connection (the caller's
identity — never the service role) and materializes one metric's readouts into
the decision graph:

  metric_observations + scope actions
        │  build causal.Series + per-action split (bisect on obs dates)
        ▼
  causal.batch_readout(series, [(action_ref, split), ...])
        │  one ActionReadout per action (ITS + descriptive + before/after +
        │  placebo + belief), BH-FDR-corrected across the metric's family
        ▼
  UPSERT nodes (METRIC, ACTION)          — idempotent on (scope, type, ref)
  UPSERT causal_edges (ACTION -> METRIC) — belief projected from the ITS readout
  APPEND evidence_objects (ITS + BEFORE_AFTER_14D)  — never mutated
  + cluster overlay (co-occurring same-metric actions -> CLUSTER node + edge)

Invariants (docs/designs/decision-graph.md):
  - Evidence is APPEND-ONLY: every run INSERTs fresh evidence rows for both
    methods; belief is a projection of the latest authoritative ITS row, so a
    re-run appends and the edge recomputes — old evidence is never touched.
  - Nodes / edges / clusters UPSERT on their natural keys, so a re-run with the
    same data converges instead of duplicating.
  - Clustering is an OVERLAY: a member keeps its own ACTION -> METRIC edge (its
    evidence flagged clustered); a member edge is never deleted or hidden.
  - ITS is authoritative: authoritative_method is always 'ITS'; the descriptive
    BEFORE_AFTER_14D row is stored as a cross-check and never drives belief.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from datetime import date, timedelta
from uuid import UUID

import numpy as np
from psycopg import Connection

from causal.batch_readout import batch_readout
from causal.types import (
    BeforeAfterResult,
    Belief,
    ITSResult,
    PlaceboResult,
    Series,
)

Id = UUID | str

# Two actions collide (mutually confound a metric) when their 14-day post-windows
# overlap. 14 days matches the descriptive BEFORE_AFTER_14D horizon — the window
# over which a shipped change is credited with moving the metric.
CLUSTER_POST_WINDOW = timedelta(days=14)


# ---------------------------------------------------------------------------
# Loading: DB rows -> the engine's pure Series + per-action intervention splits.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _LoadedMetric:
    series: Series          # engine input; split is per-action, filled downstream
    ordinals: list[int]     # obs_date.toordinal(), sorted — the bisect target
    date_min: date
    date_max: date


@dataclass(frozen=True)
class _Action:
    action_id: UUID
    ref: str                # display name: external_ref, else source
    effective_date: date
    split: int              # index of the first observation on/after effective_date


@dataclass(frozen=True)
class _Cluster:
    members: list[_Action]
    window_start: date
    window_end: date
    split: int              # earliest member's split — the cluster's one intervention


def _load_metric(conn: Connection, metric_id: Id) -> _LoadedMetric | None:
    """The metric's daily series as int64 ordinal days + float64 values (NULL ->
    NaN, which the engine's degeneracy guards handle). None when it has no data."""
    rows = conn.execute(
        "select obs_date, value from public.metric_observations "
        "where metric_id = %s order by obs_date",
        (metric_id,),
    ).fetchall()
    if not rows:
        return None
    ordinals = [d.toordinal() for d, _ in rows]
    values = np.array(
        [float(v) if v is not None else np.nan for _, v in rows], dtype=np.float64
    )
    series = Series(np.array(ordinals, dtype=np.int64), values, 0)
    return _LoadedMetric(series, ordinals, rows[0][0], rows[-1][0])


def _load_actions(conn: Connection, scope_id: Id, metric: _LoadedMetric) -> list[_Action]:
    """The scope's actions whose effective_date falls within the series range,
    each mapped to its split: bisect_left places the intervention at the first
    observation on/after effective_date (that day is the first post point)."""
    rows = conn.execute(
        "select action_id, external_ref, source, effective_date from public.actions "
        "where scope_id = %s and effective_date is not null "
        "and effective_date between %s and %s "
        "order by effective_date, action_id",
        (scope_id, metric.date_min, metric.date_max),
    ).fetchall()
    return [
        _Action(action_id, external_ref or source, eff,
                bisect_left(metric.ordinals, eff.toordinal()))
        for action_id, external_ref, source, eff in rows
    ]


def _cluster(actions: list[_Action]) -> list[_Cluster]:
    """Single-linkage sweep: actions whose 14-day post-windows chain-overlap form
    one group. A group of >= 2 is a cluster (a lone action is not a collision).
    `actions` must be sorted by effective_date (the query guarantees it)."""
    groups: list[list[_Action]] = []
    current: list[_Action] = []
    for action in actions:
        if current and action.effective_date - current[-1].effective_date > CLUSTER_POST_WINDOW:
            groups.append(current)
            current = []
        current.append(action)
    if current:
        groups.append(current)
    return [
        _Cluster(g, g[0].effective_date, g[-1].effective_date + CLUSTER_POST_WINDOW, g[0].split)
        for g in groups
        if len(g) >= 2
    ]


# ---------------------------------------------------------------------------
# Writers: idempotent node/edge/cluster upserts + append-only evidence inserts.
# ---------------------------------------------------------------------------


def _upsert_node(conn: Connection, scope_id: Id, node_type: str,
                 semantic_ref: Id, display_name: str | None) -> UUID:
    return conn.execute(
        "insert into public.nodes (scope_id, type, semantic_ref, display_name) "
        "values (%s, %s, %s, %s) "
        "on conflict (scope_id, type, semantic_ref) "
        "do update set display_name = excluded.display_name "
        "returning node_id",
        (scope_id, node_type, semantic_ref, display_name),
    ).fetchone()[0]


def _upsert_edge(conn: Connection, scope_id: Id, source_node_id: UUID,
                 target_node_id: UUID, belief: Belief) -> UUID:
    """Materialize the edge. belief is projected from the authoritative ITS
    readout; a re-run recomputes it here from the latest run's ITS result."""
    return conn.execute(
        "insert into public.causal_edges "
        "(scope_id, source_node_id, target_node_id, direction, belief_score, "
        " authoritative_method, belief_reason, last_updated) "
        "values (%s, %s, %s, %s, %s, 'ITS', %s, now()) "
        "on conflict (source_node_id, target_node_id) do update set "
        "direction = excluded.direction, belief_score = excluded.belief_score, "
        "authoritative_method = excluded.authoritative_method, "
        "belief_reason = excluded.belief_reason, last_updated = now() "
        "returning edge_id",
        (scope_id, source_node_id, target_node_id, belief.direction,
         belief.belief_score, belief.reason),
    ).fetchone()[0]


def _append_its_evidence(conn: Connection, scope_id: Id, edge_id: UUID,
                         action_id: UUID | None, cluster_id: UUID | None,
                         its: ITSResult, placebo: PlaceboResult, clustered: bool) -> None:
    """Append the authoritative ITS evidence row with the raw stats the deferred
    belief model reuses (n_pre/n_post, resid_var, cond_number, durbin_watson, placebo).
    durbin_watson is stored because belief_direction CONSUMES it (the AUTOCORRELATION
    gate), so without it the edge's belief is not reproducible from this row."""
    conn.execute(
        "insert into public.evidence_objects "
        "(scope_id, edge_id, action_id, cluster_id, methodology, lift, ci_low, "
        " ci_high, p_value, confounded, clustered, n_pre, n_post, resid_var, "
        " cond_number, durbin_watson, placebo_lift, placebo_fired) "
        "values (%s, %s, %s, %s, 'ITS', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (scope_id, edge_id, action_id, cluster_id, its.lift, its.ci_low, its.ci_high,
         its.p_value, its.status == "CONFOUNDED", clustered, its.n_pre, its.n_post,
         its.resid_var, its.cond_number, its.durbin_watson,
         placebo.placebo_lift, placebo.fired),
    )


def _append_before_after_evidence(conn: Connection, scope_id: Id, edge_id: UUID,
                                  action_id: UUID | None, cluster_id: UUID | None,
                                  before_after: BeforeAfterResult, clustered: bool) -> None:
    """Append the DESCRIPTIVE cross-check row. Non-authoritative: it carries no
    p_value / stats and never drives belief (decision-graph.md)."""
    conn.execute(
        "insert into public.evidence_objects "
        "(scope_id, edge_id, action_id, cluster_id, methodology, lift, ci_low, "
        " ci_high, confounded, clustered) "
        "values (%s, %s, %s, %s, 'BEFORE_AFTER_14D', %s, %s, %s, %s, %s)",
        (scope_id, edge_id, action_id, cluster_id, before_after.lift,
         before_after.ci_low, before_after.ci_high, False, clustered),
    )


def _upsert_cluster(conn: Connection, scope_id: Id, metric_id: Id, cluster: _Cluster) -> UUID:
    """Upsert on the cluster's STABLE identity — (scope, metric, window_start), the
    earliest member's date — and grow window_end in place. Keying on the full window
    (…, window_end) instead would mint a NEW cluster row every time a later action
    extends the group's window, orphaning the prior cluster's node/edge/evidence.
    Two collision groups on one metric are >14 days apart, so their earliest-member
    dates differ: window_start is a unique, re-run-stable key for the group."""
    return conn.execute(
        "insert into public.clusters (scope_id, metric_id, window_start, window_end) "
        "values (%s, %s, %s, %s) "
        "on conflict (scope_id, metric_id, window_start) "
        "do update set window_end = excluded.window_end "
        "returning cluster_id",
        (scope_id, metric_id, cluster.window_start, cluster.window_end),
    ).fetchone()[0]


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------


def persist_metric_readouts(conn: Connection, scope_id: Id, metric_id: Id) -> None:
    """Run the engine for one metric and materialize the result into the graph.

    Idempotent: nodes/edges/clusters upsert, evidence appends. Commits once at the
    end so the whole materialization lands atomically. `conn` must be RLS-scoped
    as the caller (member+ over `scope_id`) — never the service role.
    """
    metric = _load_metric(conn, metric_id)
    if metric is None:
        return  # no observations yet — nothing to materialize

    # The metric's OWN scope is authoritative for where its graph is materialized.
    # Trusting the passed scope_id would let persist_metric_readouts(WS_X, metric_in_WS_Y)
    # stamp WS_X's graph rows onto a metric owned by WS_Y — a workspace-isolation breach
    # RLS cannot catch (an org member is a member of both). Refuse the cross-scope write.
    metric_row = conn.execute(
        "select scope_id, name from public.metrics where metric_id = %s", (metric_id,)
    ).fetchone()
    if metric_row is None:
        return  # metric not visible under RLS — nothing to materialize
    metric_scope_id, metric_display = metric_row
    if str(metric_scope_id) != str(scope_id):
        raise ValueError(
            f"metric {metric_id} belongs to scope {metric_scope_id}, not the passed "
            f"scope {scope_id}; refusing cross-scope materialization"
        )
    metric_node_id = _upsert_node(conn, scope_id, "METRIC", metric_id, metric_display)

    actions = _load_actions(conn, scope_id, metric)
    clusters = _cluster(actions)
    clustered_action_ids = {a.action_id for c in clusters for a in c.members}

    if actions:
        readouts = batch_readout(
            metric.series, [(str(a.action_id), a.split) for a in actions]
        )
        by_ref = {r.action_ref: r for r in readouts}
        for action in actions:
            readout = by_ref[str(action.action_id)]
            action_node_id = _upsert_node(conn, scope_id, "ACTION", action.action_id, action.ref)
            edge_id = _upsert_edge(conn, scope_id, action_node_id, metric_node_id, readout.belief)
            clustered = action.action_id in clustered_action_ids
            _append_its_evidence(
                conn, scope_id, edge_id, action.action_id, None,
                readout.its, readout.placebo, clustered,
            )
            _append_before_after_evidence(
                conn, scope_id, edge_id, action.action_id, None,
                readout.before_after, clustered,
            )

    _persist_clusters(conn, scope_id, metric_id, metric_node_id, metric, clusters)
    conn.commit()


def _persist_clusters(conn: Connection, scope_id: Id, metric_id: Id, metric_node_id: UUID,
                      metric: _LoadedMetric, clusters: list[_Cluster]) -> list[UUID]:
    """Overlay: a CLUSTER node + CLUSTER -> METRIC edge per collision group, with
    its own ITS readout (the group treated as one intervention at its earliest
    member's split). Members keep their own ACTION -> METRIC edges — this only
    adds; it never deletes or zeroes a member. Returns the cluster ids."""
    if not clusters:
        return []
    cluster_ids: list[UUID] = []
    readouts = batch_readout(
        metric.series, [(f"cluster:{i}", c.split) for i, c in enumerate(clusters)]
    )
    for readout, cluster in zip(readouts, clusters):
        cluster_id = _upsert_cluster(conn, scope_id, metric_id, cluster)
        cluster_ids.append(cluster_id)
        conn.execute(
            "update public.actions set cluster_id = %s where action_id = any(%s)",
            (cluster_id, [a.action_id for a in cluster.members]),
        )
        cluster_node_id = _upsert_node(
            conn, scope_id, "CLUSTER", cluster_id, f"Cluster of {len(cluster.members)} actions"
        )
        edge_id = _upsert_edge(conn, scope_id, cluster_node_id, metric_node_id, readout.belief)
        _append_its_evidence(
            conn, scope_id, edge_id, None, cluster_id, readout.its, readout.placebo, True
        )
        _append_before_after_evidence(
            conn, scope_id, edge_id, None, cluster_id, readout.before_after, True
        )
    return cluster_ids


def persist_lever_cluster_readout(
    conn: Connection, scope_id: Id, metric_id: Id, action_ids: list[UUID]
) -> UUID | None:
    """Materialize the multi-lever cluster (C4/#17): a CLUSTER node +
    CLUSTER -> METRIC edge over exactly these lever actions, measured as ONE
    intervention at the earliest ship date — single-intervention ITS on the
    cluster's combined window, via the same collision-overlay writers (no new
    ITS method). Idempotent like the collision overlay (the cluster upserts on
    its stable (scope, metric, window_start) identity). Returns the cluster_id,
    or None when the metric has no observations or no member has shipped.

    `conn` must be RLS-scoped as the caller, exactly like persist_metric_readouts.
    """
    metric = _load_metric(conn, metric_id)
    if metric is None:
        return None
    metric_row = conn.execute(
        "select scope_id, name from public.metrics where metric_id = %s", (metric_id,)
    ).fetchone()
    if metric_row is None:
        return None
    metric_scope_id, metric_display = metric_row
    if str(metric_scope_id) != str(scope_id):
        raise ValueError(
            f"metric {metric_id} belongs to scope {metric_scope_id}, not the passed "
            f"scope {scope_id}; refusing cross-scope materialization"
        )

    rows = conn.execute(
        "select action_id, external_ref, source, effective_date from public.actions "
        "where action_id = any(%s) and effective_date is not null "
        "order by effective_date, action_id",
        (list(action_ids),),
    ).fetchall()
    members = [
        _Action(action_id, external_ref or source, eff,
                bisect_left(metric.ordinals, eff.toordinal()))
        for action_id, external_ref, source, eff in rows
    ]
    if not members:
        return None
    cluster = _Cluster(
        members,
        members[0].effective_date,
        members[-1].effective_date + CLUSTER_POST_WINDOW,
        members[0].split,
    )
    metric_node_id = _upsert_node(conn, scope_id, "METRIC", metric_id, metric_display)
    cluster_ids = _persist_clusters(
        conn, scope_id, metric_id, metric_node_id, metric, [cluster]
    )
    conn.commit()
    return cluster_ids[0]
