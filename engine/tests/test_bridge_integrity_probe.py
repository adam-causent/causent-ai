"""Regression guards for the persistence bridge (feat/persistence-bridge).

These began life as adversarial integrity PROBES that asserted three concrete
data-integrity / RLS defects in engine/persistence/bridge.py. Those defects were
fixed (commit 2645d9b + migration 20260703234500_bridge_integrity_fixes.sql), so
the probes were INVERTED here: they now assert the CORRECT, fixed behavior and
lock it in permanently. Each test still SEEDS its own namespaced tenant as the
(bypassrls) postgres superuser, runs the bridge AS THE USER over a fresh RLS-scoped
`authenticated` connection (the e2e harness contract), and reads the result back.

Guards enforced here:
  A) FDR DEMOTION IS AUDITABLE — an ACTION->METRIC edge whose would-be 1.0/POSITIVE
     belief is demoted by BH-FDR (batch_readout) across the metric's action family is
     persisted as 0.5/INCONCLUSIVE *with belief_reason = 'FDR_DEMOTED'*, and the
     authoritative ITS evidence row (incl. durbin_watson) is preserved. The demotion is
     therefore recorded + reproducible from persisted evidence — the edge never SILENTLY
     disagrees with its authoritative ITS evidence row.
  B) NO CROSS-SCOPE MATERIALIZATION — persist_metric_readouts derives the scope from the
     metric's OWN scope_id and REFUSES (ValueError) a call whose scope_id != the metric's
     scope. No METRIC node / edge / evidence is ever materialized into a scope different
     from the metric it references, even for an org member of both workspaces (RLS cannot
     catch that; the bridge does).
  D) CLUSTER RE-MATERIALIZATION IS IDEMPOTENT — clusters key on the STABLE earliest-member
     identity (scope, metric, window_start). When a later action extends a collision
     group's window, a re-run UPDATES window_end in place instead of minting a new
     cluster/node/edge, so one collision group is always represented by exactly one live
     CLUSTER->METRIC edge — no stale orphan.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from bisect import bisect_left
from datetime import date, timedelta

import numpy as np
import psycopg
import pytest

from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import Series
from persistence.bridge import persist_metric_readouts

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
_START = date(2026, 1, 1)


def _su() -> psycopg.Connection:
    c = psycopg.connect(DSN)
    c.autocommit = True
    return c


@contextlib.contextmanager
def _as_user(user_id: uuid.UUID, autocommit: bool = True):
    conn = psycopg.connect(DSN)
    conn.autocommit = autocommit
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        yield conn
    finally:
        conn.close()


def _run_bridge_as_user(user_id: uuid.UUID, scope_id: uuid.UUID, metric_id: uuid.UUID) -> None:
    conn = psycopg.connect(DSN)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        persist_metric_readouts(conn, scope_id, metric_id)
    finally:
        conn.close()


def _seed_scope_spine(cur, org, proj, ws, user, role="owner"):
    cur.execute("insert into auth.users (id) values (%s) on conflict do nothing", (user,))
    cur.execute("insert into public.orgs (org_id, name) values (%s,'PROBE_org')", (org,))
    cur.execute("insert into public.projects (project_id, org_id, name) values (%s,%s,'PROBE_proj')", (proj, org))
    cur.execute("insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,'PROBE_ws')", (ws, proj))
    cur.execute("insert into public.memberships (user_id, org_id, role) values (%s,%s,%s)", (user, org, role))


# ============================================================================
# REGRESSION A — BH-FDR belief demotion is AUDITABLE, not silent.
# ============================================================================
def test_regression_fdr_demotion_is_auditable_not_silent():
    ORG = uuid.uuid4(); PROJ = uuid.uuid4(); WS = uuid.uuid4(); USER = uuid.uuid4()
    METRIC = uuid.uuid4()
    S = uuid.uuid4()                       # the marginally-significant action
    INCON = [uuid.uuid4() for _ in range(4)]

    # A 160-day series, base 100 + N(0,4) noise, with a MODEST +2 step at index 70.
    # (Tuned offline: S individually reads OK / CI-excludes-0 / DW ok / placebo clean
    #  -> belief 1.0 POSITIVE, p ~ 0.05; but 4 co-metric OK-inconclusive actions inflate
    #  the BH family so batch_readout demotes S to 0.5 / INCONCLUSIVE with reason
    #  FDR_DEMOTED — the demotion is recorded, so the edge stays auditable.)
    n, step_at = 160, 70
    rng = np.random.default_rng(7)
    vals = 100.0 + rng.normal(0.0, 4.0, n)
    vals[step_at:] += 2.0
    dates = [_START + timedelta(days=i) for i in range(n)]
    incon_idx = [100, 105, 110, 115]

    su = _su()
    try:
        with su.cursor() as cur:
            _seed_scope_spine(cur, ORG, PROJ, WS, USER)
            cur.execute("insert into public.metrics (metric_id, scope_id, name, source) values (%s,%s,'PROBE_A','csv')", (METRIC, WS))
            cur.executemany(
                "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
                [(METRIC, d, float(v)) for d, v in zip(dates, vals)],
            )
            cur.execute(
                "insert into public.actions (action_id, scope_id, source, external_ref, effective_date) values (%s,%s,'manual','S',%s)",
                (S, WS, dates[step_at]),
            )
            for a, idx in zip(INCON, incon_idx):
                cur.execute(
                    "insert into public.actions (action_id, scope_id, source, external_ref, effective_date) values (%s,%s,'manual','I',%s)",
                    (a, WS, dates[idx]),
                )

        _run_bridge_as_user(USER, WS, METRIC)

        with su.cursor() as cur:
            # The persisted ACTION->METRIC edge for S.
            cur.execute(
                "select ce.belief_score, ce.direction, ce.belief_reason, ce.authoritative_method "
                "from public.causal_edges ce join public.nodes n on n.node_id = ce.source_node_id "
                "where n.type='ACTION' and n.semantic_ref=%s and ce.scope_id=%s",
                (S, WS),
            )
            belief_score, direction, belief_reason, method = cur.fetchone()

            # Recompute the AUTHORITATIVE ITS readout from the exact DB series the bridge
            # loaded (mirrors test_bridge_e2e Gate 3's own oracle).
            cur.execute(
                "select obs_date, value from public.metric_observations where metric_id=%s order by obs_date",
                (METRIC,),
            )
            rows = cur.fetchall()
            ords = [d.toordinal() for d, _ in rows]
            vv = np.array([float(v) for _, v in rows], dtype=np.float64)
            split = bisect_left(ords, dates[step_at].toordinal())
            view = Series(np.array(ords, dtype=np.int64), vv, split)
            its = its_readout(view)
            placebo = placebo_in_time(view, its)
            authoritative = belief_direction(its, placebo)

            # The latest ITS evidence row this edge points at.
            cur.execute(
                "select ce.edge_id from public.causal_edges ce join public.nodes n on n.node_id=ce.source_node_id "
                "where n.type='ACTION' and n.semantic_ref=%s and ce.scope_id=%s", (S, WS))
            edge_id = cur.fetchone()[0]
            cur.execute(
                "select lift, ci_low, ci_high, p_value, placebo_fired, durbin_watson from public.evidence_objects "
                "where edge_id=%s and methodology='ITS' order by created_at desc, evidence_id desc limit 1",
                (edge_id,))
            ev_lift, ev_ci_low, ev_ci_high, ev_p, ev_placebo_fired, ev_dw = cur.fetchone()

        print("\n[REGRESSION A] BH-FDR demotion is auditable")
        print(f"  authoritative ITS readout  : belief={authoritative.belief_score} dir={authoritative.direction} reason={authoritative.reason}")
        print(f"  persisted edge             : belief={belief_score} dir={direction} reason={belief_reason} method={method}")
        print(f"  latest ITS evidence row    : lift={float(ev_lift):.4f} ci=({float(ev_ci_low):.4f},{float(ev_ci_high):.4f}) p={float(ev_p):.4f} placebo_fired={ev_placebo_fired} dw={ev_dw}")

        # Pre-FDR, the ITS readout on this edge's own evidence supports a CONFIDENT edge...
        assert authoritative.belief_score == 1.0 and authoritative.direction == "POSITIVE"
        # ...and the persisted authoritative evidence row PROVES it: significant positive
        # step (CI excludes 0), placebo clean, and durbin_watson persisted (reproducible).
        assert float(ev_ci_low) > 0.0 and float(ev_p) < 0.05 and not ev_placebo_fired
        assert ev_dw is not None, "durbin_watson must be persisted so belief is reproducible from the row"
        # The edge is demoted by BH-FDR across the metric's action family...
        assert belief_score is not None and abs(float(belief_score) - 0.5) < 1e-9
        assert direction == "INCONCLUSIVE"
        assert method == "ITS"
        # ...but the demotion is RECORDED — belief_reason = 'FDR_DEMOTED', not NULL — so the
        # edge does NOT silently disagree with its authoritative evidence: the disagreement
        # is auditable and reconcilable (raw effect in evidence, demotion cause on the edge).
        assert belief_reason == "FDR_DEMOTED", (
            "FDR demotion must be recorded on the edge so it is auditable, not silent"
        )
        print("  => GUARD HOLDS: edge demoted to 0.5/INCONCLUSIVE carries reason FDR_DEMOTED; "
              "the raw significant ITS result is preserved in evidence (with durbin_watson), so "
              "the demotion is auditable and reproducible — no silent drift.")
    finally:
        with su.cursor() as cur:
            cur.execute("delete from public.orgs where org_id=%s", (ORG,))
            cur.execute("delete from auth.users where id=%s", (USER,))
        su.close()


# ============================================================================
# REGRESSION B — no cross-scope materialization (bridge derives scope from metric).
# ============================================================================
def test_regression_no_cross_scope_materialization():
    ORG = uuid.uuid4(); PROJ = uuid.uuid4(); USER = uuid.uuid4()
    WS_X = uuid.uuid4()   # the scope we PASS
    WS_Y = uuid.uuid4()   # the scope the metric actually LIVES in
    METRIC_Y = uuid.uuid4()

    n = 120
    rng = np.random.default_rng(3)
    vals = 100.0 + rng.normal(0.0, 2.0, n)
    dates = [_START + timedelta(days=i) for i in range(n)]

    su = _su()
    try:
        with su.cursor() as cur:
            # One org, one project, two workspaces. Org-level OWNER => member of BOTH.
            cur.execute("insert into auth.users (id) values (%s) on conflict do nothing", (USER,))
            cur.execute("insert into public.orgs (org_id, name) values (%s,'PROBE_B_org')", (ORG,))
            cur.execute("insert into public.projects (project_id, org_id, name) values (%s,%s,'p')", (PROJ, ORG))
            cur.execute("insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,'WS_X')", (WS_X, PROJ))
            cur.execute("insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,'WS_Y')", (WS_Y, PROJ))
            cur.execute("insert into public.memberships (user_id, org_id, role) values (%s,%s,'owner')", (USER, ORG))
            # The metric lives in WS_Y.
            cur.execute("insert into public.metrics (metric_id, scope_id, name, source) values (%s,%s,'M_Y','csv')", (METRIC_Y, WS_Y))
            cur.executemany(
                "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
                [(METRIC_Y, d, float(v)) for d, v in zip(dates, vals)],
            )

        # Call the bridge with a MISMATCHED (scope=WS_X, metric=M_Y in WS_Y). RLS lets the
        # rows be visible (org member of both), but the bridge REFUSES the cross-scope write.
        with pytest.raises(ValueError, match="cross-scope"):
            _run_bridge_as_user(USER, WS_X, METRIC_Y)

        with su.cursor() as cur:
            # No METRIC node for M_Y was materialized anywhere — not in X, not in Y.
            cur.execute(
                "select count(*) from public.nodes n "
                "where n.type='METRIC' and n.semantic_ref=%s", (METRIC_Y,))
            metric_nodes = cur.fetchone()[0]
            cur.execute("select scope_id from public.metrics where metric_id=%s", (METRIC_Y,))
            metric_scope = cur.fetchone()[0]

        print("\n[REGRESSION B] no cross-scope materialization")
        print(f"  METRIC nodes materialized for M_Y : {metric_nodes} (expected 0)")
        print(f"  metric M_Y lives in scope         : {metric_scope}")
        assert metric_scope == WS_Y, "sanity: the metric belongs to scope Y"
        assert metric_nodes == 0, (
            "bridge must NOT materialize a graph row for a metric into a mismatched scope"
        )
        print("  => GUARD HOLDS: persist_metric_readouts(WS_X, metric_in_WS_Y) raised ValueError "
              "and wrote nothing; the bridge derives scope from the metric and refuses the "
              "workspace-isolation breach RLS cannot catch.")
    finally:
        with su.cursor() as cur:
            cur.execute("delete from public.orgs where org_id=%s", (ORG,))
            cur.execute("delete from auth.users where id=%s", (USER,))
        su.close()


# ============================================================================
# REGRESSION D — cluster re-materialization is idempotent when the window grows.
# ============================================================================
def test_regression_cluster_rematerialization_is_idempotent():
    ORG = uuid.uuid4(); PROJ = uuid.uuid4(); WS = uuid.uuid4(); USER = uuid.uuid4()
    METRIC = uuid.uuid4()
    B = uuid.uuid4(); C = uuid.uuid4(); D = uuid.uuid4()

    n = 120
    rng = np.random.default_rng(5)
    vals = 100.0 + rng.normal(0.0, 2.0, n)
    dates = [_START + timedelta(days=i) for i in range(n)]
    # B@30, C@43 (13d after B -> collide), D@53 (10d after C -> extends the same group).
    iB, iC, iD = 30, 43, 53

    su = _su()
    try:
        with su.cursor() as cur:
            _seed_scope_spine(cur, ORG, PROJ, WS, USER)
            cur.execute("insert into public.metrics (metric_id, scope_id, name, source) values (%s,%s,'PROBE_D','csv')", (METRIC, WS))
            cur.executemany(
                "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
                [(METRIC, d, float(v)) for d, v in zip(dates, vals)],
            )
            # RUN-1 population: only B and C (they collide into one cluster).
            cur.executemany(
                "insert into public.actions (action_id, scope_id, source, external_ref, effective_date) values (%s,%s,'manual',%s,%s)",
                [(B, WS, "B", dates[iB]), (C, WS, "C", dates[iC])],
            )

        _run_bridge_as_user(USER, WS, METRIC)  # RUN 1

        def cluster_counts():
            with su.cursor() as cur:
                cur.execute("select count(*) from public.clusters where scope_id=%s and metric_id=%s", (WS, METRIC))
                clusters = cur.fetchone()[0]
                cur.execute("select count(*) from public.nodes where scope_id=%s and type='CLUSTER'", (WS,))
                cnodes = cur.fetchone()[0]
                cur.execute(
                    "select count(*) from public.causal_edges ce join public.nodes n on n.node_id=ce.source_node_id "
                    "where ce.scope_id=%s and n.type='CLUSTER'", (WS,))
                cedges = cur.fetchone()[0]
                return clusters, cnodes, cedges

        after_run1 = cluster_counts()

        # Now a LATER action D ships within 14d of C, extending the collision group's window.
        with su.cursor() as cur:
            cur.execute(
                "insert into public.actions (action_id, scope_id, source, external_ref, effective_date) values (%s,%s,'manual','D',%s)",
                (D, WS, dates[iD]),
            )

        _run_bridge_as_user(USER, WS, METRIC)  # RUN 2 (same metric, one new action)

        after_run2 = cluster_counts()

        print("\n[REGRESSION D] cluster re-materialization is idempotent")
        print(f"  run1 (B,C)      -> clusters={after_run1[0]} cluster_nodes={after_run1[1]} cluster_edges={after_run1[2]}")
        print(f"  run2 (B,C,D)    -> clusters={after_run2[0]} cluster_nodes={after_run2[1]} cluster_edges={after_run2[2]}")
        assert after_run1 == (1, 1, 1), f"run1 should make exactly one cluster overlay, got {after_run1}"
        # The collision group is STILL a single group (B,C,D); the window grew, but keying on
        # the STABLE earliest-member (window_start) means the re-run UPDATES window_end in
        # place — no new cluster/node/edge is minted, so it stays exactly one live overlay.
        assert after_run2 == (1, 1, 1), (
            f"cluster re-materialization must be idempotent (grown window updates in place), got {after_run2}"
        )
        # Prove there is NO orphan and every member points at the ONE surviving cluster.
        with su.cursor() as cur:
            cur.execute(
                "select c.cluster_id from public.clusters c where c.scope_id=%s and c.metric_id=%s "
                "and not exists (select 1 from public.actions a where a.cluster_id=c.cluster_id)",
                (WS, METRIC))
            orphaned = cur.fetchall()
            cur.execute("select cluster_id from public.actions where action_id in (%s,%s,%s)", (B, C, D))
            member_cluster_ids = {r[0] for r in cur.fetchall()}
        print(f"  orphaned cluster rows (no member points at them): {len(orphaned)}")
        print(f"  B,C,D all point at the SAME cluster id: {member_cluster_ids}")
        assert len(orphaned) == 0, "the grown window must not leave the run-1 cluster orphaned"
        assert len(member_cluster_ids) == 1 and None not in member_cluster_ids, (
            "B, C and D must all point at the one surviving cluster"
        )
        print("  => GUARD HOLDS: one collision group is represented by exactly one live "
              "CLUSTER->METRIC edge after the window grew; the overlay updates in place, "
              "leaving no stale orphan.")
    finally:
        with su.cursor() as cur:
            cur.execute("delete from public.orgs where org_id=%s", (ORG,))
            cur.execute("delete from auth.users where id=%s", (USER,))
        su.close()
