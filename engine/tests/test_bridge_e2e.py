"""LIVE end-to-end gate for Causent's persistence bridge.

Runs against the local Supabase Postgres. As the (bypassrls) postgres superuser we
SEED a single fully-populated tenant — one org/project/workspace scope, a user with
an OWNER membership, ONE metric carrying 120 daily observations with a STRONG +40
level step injected at action A's date, and three actions in that scope:

  A) effective_date at the injected step, 50 pre / 70 post days  -> belief 1.0 POSITIVE
  B) effective_date on the flat post-step plateau, 74 / 46 days   -> INCONCLUSIVE (belief != 1.0)
  C) effective_date near the end, 87 pre / 33 post (< FLOOR)      -> INSUFFICIENT_HISTORY (belief None)

B and C ship 13 days apart (<= the 14-day cluster window) so they COLLIDE into one
CLUSTER; A is 24 days before B, so A stays a lone action.

Then we run the bridge AS THE USER over a fresh RLS-scoped connection:

    SET ROLE authenticated;
    SELECT set_config('request.jwt.claims',
        json_build_object('sub', <user-uuid>, 'role', 'authenticated')::text, false);
    persist_metric_readouts(conn, scope_id, metric_id)

`authenticated` is not a superuser and does not bypass RLS, so every write the bridge
issues is actually gated by the policies in supabase/migrations/*_v1_rls.sql.

The gate (see the test_* functions):
  - evidence_objects: exactly 2 method rows (ITS + BEFORE_AFTER_14D) per eligible
    action + the cluster; a SECOND run APPENDS (never UPDATEs/DELETEs) — and
    authenticated has no UPDATE/DELETE privilege on evidence at all.
  - causal_edges: one ACTION->METRIC edge per action; A POSITIVE / belief 1.0;
    B INCONCLUSIVE / belief != 1.0; C belief None / reason INSUFFICIENT_HISTORY.
  - each edge's belief == belief_direction() computed on the authoritative ITS
    readout the latest ITS evidence row materializes.
  - RLS on writes: persisting a metric in ANOTHER (unmembered) scope writes NOTHING.
  - nodes: METRIC + ACTION nodes exist; B/C collide, so a CLUSTER node + CLUSTER edge
    exist and the members keep their own ACTION->METRIC edges.

Nothing here weakens an assertion to make the suite pass; a real regression fails the gate.
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
from psycopg import errors as pgerr

from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import Series
from persistence.bridge import persist_metric_readouts

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# --- Deterministic seed UUIDs (namespaced so teardown is exact) ---------------
ORG = uuid.UUID("dddd0000-0000-0000-0000-0000000000d1")
PROJ = uuid.UUID("dddd0000-0000-0000-0000-0000000000d2")
SCOPE = uuid.UUID("dddd0000-0000-0000-0000-0000000000d3")  # the workspace (operating level)
USER = uuid.UUID("dddd1111-0000-0000-0000-0000000000d9")   # OWNER of the org
METRIC = uuid.UUID("dddd0000-0000-0000-0000-0000000000da")
ACTION_A = uuid.UUID("dddd0000-0000-0000-0000-0000000000a0")
ACTION_B = uuid.UUID("dddd0000-0000-0000-0000-0000000000b0")
ACTION_C = uuid.UUID("dddd0000-0000-0000-0000-0000000000c0")

# A second tenant the USER has NO membership in — the RLS write-isolation target.
FORG = uuid.UUID("eeee0000-0000-0000-0000-0000000000e1")
FPROJ = uuid.UUID("eeee0000-0000-0000-0000-0000000000e2")
FSCOPE = uuid.UUID("eeee0000-0000-0000-0000-0000000000e3")
FMETRIC = uuid.UUID("eeee0000-0000-0000-0000-0000000000ea")

# --- The metric series --------------------------------------------------------
# 120 daily observations, base 100 + N(0, 2) noise, with a STRONG +40 permanent
# step at index 50 (action A's date). B and C are placed on the flat +140 plateau
# so their local level is continuous (no step at their date) — the ITS reads their
# step as ~0 (INCONCLUSIVE / INSUFFICIENT_HISTORY), while A's is a clean +40.
_N = 120
_STEP_INDEX = 50
_START = date(2026, 1, 1)
_DATES = [_START + timedelta(days=i) for i in range(_N)]
_ORDINALS = [d.toordinal() for d in _DATES]

_rng = np.random.default_rng(42)
_VALUES = 100.0 + _rng.normal(0.0, 2.0, _N)
_VALUES[_STEP_INDEX:] += 40.0

# Action effective-date indices (their split within the shared series).
_IDX_A = _STEP_INDEX  # 50 -> 50 pre / 70 post (the injected step)
_IDX_B = 74           # 74 pre / 46 post (both sides >= FLOOR_CONFIDENT=45)
_IDX_C = 87           # 87 pre / 33 post (< 45 post -> INSUFFICIENT_HISTORY)
_ACTION_INDEX = {ACTION_A: _IDX_A, ACTION_B: _IDX_B, ACTION_C: _IDX_C}


# --- Connection helpers -------------------------------------------------------
def _superuser_conn() -> psycopg.Connection:
    conn = psycopg.connect(DSN)
    conn.autocommit = True
    return conn


@contextlib.contextmanager
def as_user(user_id: uuid.UUID, autocommit: bool = True):
    """Fresh connection acting AS `user_id` under RLS (role=authenticated)."""
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
    """Open a RLS-scoped connection AS the user and run the bridge over one metric.

    autocommit=False so the bridge's single terminal commit() lands the whole
    materialization atomically — exactly its production contract."""
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


# --- Seed / teardown ----------------------------------------------------------
def _teardown(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from public.orgs where org_id = any(%s)", ([ORG, FORG],))
        cur.execute("delete from auth.users where id = %s", (USER,))


def _seed(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("insert into auth.users (id) values (%s)", (USER,))

        # Primary tenant + the USER's OWNER membership (org-wide grant).
        cur.execute("insert into public.orgs (org_id, name) values (%s,%s)", (ORG, "E2E_org"))
        cur.execute(
            "insert into public.projects (project_id, org_id, name) values (%s,%s,%s)",
            (PROJ, ORG, "E2E_proj"),
        )
        cur.execute(
            "insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,%s)",
            (SCOPE, PROJ, "E2E_ws"),
        )
        cur.execute(
            "insert into public.memberships (user_id, org_id, role) values (%s,%s,'owner')",
            (USER, ORG),
        )

        # The metric + its 120 daily observations (the injected-step series).
        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source) values (%s,%s,%s,'csv')",
            (METRIC, SCOPE, "E2E_signups"),
        )
        cur.executemany(
            "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
            [(METRIC, d, float(v)) for d, v in zip(_DATES, _VALUES)],
        )

        # Three actions in the scope, each with an effective_date inside the series.
        cur.executemany(
            "insert into public.actions (action_id, scope_id, source, external_ref, effective_date) "
            "values (%s,%s,'manual',%s,%s)",
            [
                (ACTION_A, SCOPE, "A", _DATES[_IDX_A]),
                (ACTION_B, SCOPE, "B", _DATES[_IDX_B]),
                (ACTION_C, SCOPE, "C", _DATES[_IDX_C]),
            ],
        )

        # A SECOND tenant the USER cannot touch — same shape, fully populated so the
        # ONLY reason the bridge writes nothing there is RLS, not "no data".
        cur.execute("insert into public.orgs (org_id, name) values (%s,%s)", (FORG, "E2E_foreign_org"))
        cur.execute(
            "insert into public.projects (project_id, org_id, name) values (%s,%s,%s)",
            (FPROJ, FORG, "E2E_foreign_proj"),
        )
        cur.execute(
            "insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,%s)",
            (FSCOPE, FPROJ, "E2E_foreign_ws"),
        )
        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source) values (%s,%s,%s,'csv')",
            (FMETRIC, FSCOPE, "E2E_foreign_metric"),
        )
        cur.executemany(
            "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
            [(FMETRIC, d, float(v)) for d, v in zip(_DATES, _VALUES)],
        )
        cur.execute(
            "insert into public.actions (action_id, scope_id, source, external_ref, effective_date) "
            "values (%s,%s,'manual','FA',%s)",
            (uuid.uuid4(), FSCOPE, _DATES[_IDX_A]),
        )


@pytest.fixture(scope="module")
def materialized():
    """Seed the tenant, run the bridge ONCE as the user, yield a superuser conn."""
    conn = _superuser_conn()
    _teardown(conn)  # clean any residue from a prior aborted run
    _seed(conn)
    _run_bridge_as_user(USER, SCOPE, METRIC)  # RUN 1
    try:
        yield conn
    finally:
        _teardown(conn)
        conn.close()


# --- Expected-belief oracle (recompute the engine from the DB-loaded series) ---
def _load_series_from_db(cur) -> tuple[list[int], np.ndarray]:
    cur.execute(
        "select obs_date, value from public.metric_observations "
        "where metric_id = %s order by obs_date",
        (METRIC,),
    )
    rows = cur.fetchall()
    ordinals = [d.toordinal() for d, _ in rows]
    values = np.array([float(v) for _, v in rows], dtype=np.float64)
    return ordinals, values


def _expected_readout(cur, action_id: uuid.UUID):
    """The engine result the bridge materialized for this action, recomputed from the
    exact series the bridge loaded — the authoritative ITS + placebo + belief."""
    ordinals, values = _load_series_from_db(cur)
    eff = _DATES[_ACTION_INDEX[action_id]]
    split = bisect_left(ordinals, eff.toordinal())
    view = Series(np.array(ordinals, dtype=np.int64), values, split)
    its = its_readout(view)
    placebo = placebo_in_time(view, its)
    belief = belief_direction(its, placebo)
    return its, placebo, belief


# --- Graph lookups ------------------------------------------------------------
def _action_edge(cur, action_id: uuid.UUID):
    """The ACTION->METRIC edge for `action_id`: joined through its ACTION node."""
    cur.execute(
        "select ce.edge_id, ce.direction, ce.belief_score, ce.belief_reason, "
        "       ce.authoritative_method, ce.target_node_id "
        "from public.causal_edges ce "
        "join public.nodes n on n.node_id = ce.source_node_id "
        "where n.type = 'ACTION' and n.semantic_ref = %s and ce.scope_id = %s",
        (action_id, SCOPE),
    )
    return cur.fetchone()


def _latest_its_evidence(cur, edge_id: uuid.UUID):
    cur.execute(
        "select lift, ci_low, ci_high, p_value, n_pre, n_post, placebo_lift, placebo_fired "
        "from public.evidence_objects "
        "where edge_id = %s and methodology = 'ITS' "
        "order by created_at desc, evidence_id desc limit 1",
        (edge_id,),
    )
    return cur.fetchone()


def _approx(a, b, rel=1e-4, abs_=1e-4) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) <= max(abs_, rel * abs(float(b)))


# ============================================================================
# GATE 1 — evidence_objects: exactly 2 method rows per eligible action + cluster
# ============================================================================
def test_two_method_rows_per_eligible_action(materialized):
    cur = materialized.cursor()
    for action_id in (ACTION_A, ACTION_B, ACTION_C):
        cur.execute(
            "select methodology, count(*) from public.evidence_objects "
            "where action_id = %s group by methodology order by methodology",
            (action_id,),
        )
        got = dict(cur.fetchall())
        assert got == {"BEFORE_AFTER_14D": 1, "ITS": 1}, (
            f"action {action_id} must have exactly one ITS + one BEFORE_AFTER_14D "
            f"evidence row after one run, got {got}"
        )
    # The cluster (B+C) also materializes both method rows (action_id NULL, cluster_id set).
    cur.execute(
        "select cluster_id from public.clusters where scope_id = %s and metric_id = %s",
        (SCOPE, METRIC),
    )
    cluster_id = cur.fetchone()[0]
    cur.execute(
        "select methodology, count(*) from public.evidence_objects "
        "where cluster_id = %s and action_id is null group by methodology order by methodology",
        (cluster_id,),
    )
    assert dict(cur.fetchall()) == {"BEFORE_AFTER_14D": 1, "ITS": 1}


# ============================================================================
# GATE 2 — causal_edges: one ACTION->METRIC edge per action, with the right belief
# ============================================================================
def test_one_edge_per_action_with_expected_belief(materialized):
    cur = materialized.cursor()

    # METRIC node is the shared target of every action edge.
    cur.execute(
        "select node_id from public.nodes where type='METRIC' and semantic_ref=%s and scope_id=%s",
        (METRIC, SCOPE),
    )
    metric_node_id = cur.fetchone()[0]

    for action_id in (ACTION_A, ACTION_B, ACTION_C):
        row = _action_edge(cur, action_id)
        assert row is not None, f"no ACTION->METRIC edge for {action_id}"
        edge_id, direction, belief_score, belief_reason, method, target = row
        assert target == metric_node_id, "edge must point at the METRIC node"
        assert method == "ITS", "ITS is authoritative on every edge"
        # exactly ONE edge per action
        cur.execute(
            "select count(*) from public.causal_edges ce "
            "join public.nodes n on n.node_id = ce.source_node_id "
            "where n.type='ACTION' and n.semantic_ref=%s and ce.scope_id=%s",
            (action_id, SCOPE),
        )
        assert cur.fetchone()[0] == 1

    # A: strong injected step -> POSITIVE, belief exactly 1.0
    _, dir_a, score_a, reason_a, _, _ = _action_edge(cur, ACTION_A)
    assert dir_a == "POSITIVE", f"A must read POSITIVE, got {dir_a}"
    assert score_a == pytest.approx(1.0), f"A belief must be 1.0, got {score_a}"

    # B: flat plateau -> INCONCLUSIVE, belief present but NOT 1.0
    _, dir_b, score_b, reason_b, _, _ = _action_edge(cur, ACTION_B)
    assert dir_b == "INCONCLUSIVE", f"B must read INCONCLUSIVE, got {dir_b}"
    assert score_b is not None and score_b != pytest.approx(1.0), (
        f"B belief must be present and != 1.0, got {score_b}"
    )

    # C: < 45 post -> belief WITHHELD (None) with reason INSUFFICIENT_HISTORY
    _, dir_c, score_c, reason_c, _, _ = _action_edge(cur, ACTION_C)
    assert score_c is None, f"C belief must be withheld (None), got {score_c}"
    assert reason_c == "INSUFFICIENT_HISTORY", f"C reason must be INSUFFICIENT_HISTORY, got {reason_c}"
    assert dir_c == "INCONCLUSIVE"


# ============================================================================
# GATE 3 — the edge belief == belief_direction() on the latest ITS evidence row
# ============================================================================
def test_edge_belief_matches_belief_direction(materialized):
    cur = materialized.cursor()
    for action_id in (ACTION_A, ACTION_B, ACTION_C):
        its, placebo, expected = _expected_readout(cur, action_id)
        edge_id, direction, belief_score, belief_reason, _, _ = _action_edge(cur, action_id)

        # (a) the persisted edge equals belief_direction() of the authoritative readout
        assert direction == expected.direction, (
            f"{action_id}: edge direction {direction} != belief_direction {expected.direction}"
        )
        assert (belief_score is None) == (expected.belief_score is None)
        if expected.belief_score is not None:
            assert belief_score == pytest.approx(expected.belief_score)
        assert belief_reason == expected.reason, (
            f"{action_id}: edge reason {belief_reason} != {expected.reason}"
        )

        # (b) the latest ITS evidence row IS that readout (proves belief_direction was
        #     computed on the evidence this edge carries, not on something else).
        ev = _latest_its_evidence(cur, edge_id)
        assert ev is not None, f"{action_id}: no ITS evidence row"
        lift, ci_low, ci_high, p_value, n_pre, n_post, placebo_lift, placebo_fired = ev
        assert n_pre == its.n_pre and n_post == its.n_post
        assert _approx(lift, its.lift), f"{action_id}: evidence lift {lift} != {its.lift}"
        assert _approx(ci_low, its.ci_low)
        assert _approx(ci_high, its.ci_high)
        assert _approx(p_value, its.p_value, rel=1e-3), f"{action_id}: p {p_value} != {its.p_value}"
        assert _approx(placebo_lift, placebo.placebo_lift)
        assert bool(placebo_fired) == bool(placebo.fired)


# ============================================================================
# GATE 4 — nodes: METRIC + ACTION nodes; B/C collide -> CLUSTER node + edge,
#          and the members keep their own ACTION->METRIC edges
# ============================================================================
def test_nodes_metric_action_and_cluster_overlay(materialized):
    cur = materialized.cursor()

    # METRIC node
    cur.execute(
        "select count(*) from public.nodes where type='METRIC' and semantic_ref=%s and scope_id=%s",
        (METRIC, SCOPE),
    )
    assert cur.fetchone()[0] == 1, "exactly one METRIC node"

    # ACTION node per action
    for action_id in (ACTION_A, ACTION_B, ACTION_C):
        cur.execute(
            "select count(*) from public.nodes where type='ACTION' and semantic_ref=%s and scope_id=%s",
            (action_id, SCOPE),
        )
        assert cur.fetchone()[0] == 1, f"exactly one ACTION node for {action_id}"

    # B and C collided into a CLUSTER (13 days apart <= 14-day window).
    cur.execute(
        "select cluster_id from public.clusters where scope_id=%s and metric_id=%s", (SCOPE, METRIC)
    )
    clusters = cur.fetchall()
    assert len(clusters) == 1, f"B and C must collide into exactly one cluster, got {len(clusters)}"
    cluster_id = clusters[0][0]

    # CLUSTER node exists...
    cur.execute(
        "select node_id from public.nodes where type='CLUSTER' and semantic_ref=%s and scope_id=%s",
        (cluster_id, SCOPE),
    )
    cluster_node = cur.fetchone()
    assert cluster_node is not None, "CLUSTER node must exist"
    cluster_node_id = cluster_node[0]

    # ...with a CLUSTER->METRIC edge.
    cur.execute(
        "select node_id from public.nodes where type='METRIC' and semantic_ref=%s and scope_id=%s",
        (METRIC, SCOPE),
    )
    metric_node_id = cur.fetchone()[0]
    cur.execute(
        "select count(*) from public.causal_edges "
        "where source_node_id=%s and target_node_id=%s and scope_id=%s",
        (cluster_node_id, metric_node_id, SCOPE),
    )
    assert cur.fetchone()[0] == 1, "exactly one CLUSTER->METRIC edge"

    # The cluster is an OVERLAY: members B and C KEEP their own ACTION->METRIC edges,
    # and are tagged into the cluster (bridge sets actions.cluster_id).
    for member in (ACTION_B, ACTION_C):
        assert _action_edge(cur, member) is not None, f"member {member} lost its own edge"
        cur.execute("select cluster_id from public.actions where action_id=%s", (member,))
        assert cur.fetchone()[0] == cluster_id, f"member {member} not tagged into the cluster"
    # A is a lone action — not clustered.
    cur.execute("select cluster_id from public.actions where action_id=%s", (ACTION_A,))
    assert cur.fetchone()[0] is None, "A must not be clustered"


# ============================================================================
# GATE 5 — RLS on WRITES: persisting a metric in ANOTHER scope writes NOTHING
# ============================================================================
def test_foreign_scope_persist_writes_nothing(materialized):
    cur = materialized.cursor()

    # Baseline: the foreign scope has no graph rows before the attempt.
    def foreign_counts():
        counts = {}
        for table in ("nodes", "causal_edges", "evidence_objects", "clusters"):
            cur.execute(f"select count(*) from public.{table} where scope_id=%s", (FSCOPE,))
            counts[table] = cur.fetchone()[0]
        return counts

    assert foreign_counts() == {"nodes": 0, "causal_edges": 0, "evidence_objects": 0, "clusters": 0}

    # Run the bridge AS THE USER against the foreign metric. RLS hides the foreign
    # observations (metric_scope returns NULL -> default-deny), so the bridge reads
    # an empty series and materializes nothing.
    _run_bridge_as_user(USER, FSCOPE, FMETRIC)

    assert foreign_counts() == {"nodes": 0, "causal_edges": 0, "evidence_objects": 0, "clusters": 0}, (
        "bridge wrote into a scope the user is not a member of — RLS write-isolation breach"
    )

    # And a DIRECT write into the foreign scope as the user is refused by the policy
    # WITH CHECK (proves it is RLS, not merely the empty read, that blocks writes).
    with as_user(USER, autocommit=False) as conn, conn.cursor() as ucur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            ucur.execute(
                "insert into public.nodes (scope_id, type, semantic_ref) values (%s,'METRIC',%s)",
                (FSCOPE, FMETRIC),
            )
        conn.rollback()


# ============================================================================
# GATE 6 — evidence is APPEND-ONLY under authenticated (no UPDATE / DELETE)
# ============================================================================
def test_evidence_authenticated_cannot_update_or_delete(materialized):
    cur = materialized.cursor()
    cur.execute(
        "select evidence_id from public.evidence_objects where scope_id=%s limit 1", (SCOPE,)
    )
    evidence_id = cur.fetchone()[0]

    with as_user(USER, autocommit=False) as conn, conn.cursor() as ucur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            ucur.execute(
                "update public.evidence_objects set lift = 999 where evidence_id = %s", (evidence_id,)
            )
        conn.rollback()
    with as_user(USER, autocommit=False) as conn, conn.cursor() as ucur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            ucur.execute(
                "delete from public.evidence_objects where evidence_id = %s", (evidence_id,)
            )
        conn.rollback()

    # The row survived untouched.
    cur.execute(
        "select count(*) from public.evidence_objects where evidence_id=%s and lift is distinct from 999",
        (evidence_id,),
    )
    assert cur.fetchone()[0] == 1


# ============================================================================
# GATE 7 — a SECOND run APPENDS evidence but does NOT duplicate nodes/edges/clusters
#          (append-only holds; upserts converge). RUN 2 lives here, LAST.
# ============================================================================
def test_second_run_appends_evidence_and_converges(materialized):
    cur = materialized.cursor()

    def counts():
        out = {}
        for table in ("nodes", "causal_edges", "clusters", "evidence_objects"):
            cur.execute(f"select count(*) from public.{table} where scope_id=%s", (SCOPE,))
            out[table] = cur.fetchone()[0]
        return out

    before = counts()
    # After RUN 1: 5 nodes (1 METRIC + 3 ACTION + 1 CLUSTER), 4 edges (3 action + 1
    # cluster), 1 cluster, 8 evidence (4 rows x 2 methods).
    assert before == {"nodes": 5, "causal_edges": 4, "clusters": 1, "evidence_objects": 8}, before

    # Snapshot the exact run-1 evidence rows (id -> lift) to prove none are mutated.
    cur.execute(
        "select evidence_id, lift from public.evidence_objects where scope_id=%s", (SCOPE,)
    )
    run1_rows = {eid: lift for eid, lift in cur.fetchall()}

    _run_bridge_as_user(USER, SCOPE, METRIC)  # RUN 2

    after = counts()
    # Nodes / edges / clusters UPSERT -> counts unchanged. Evidence APPENDS -> doubles.
    assert after["nodes"] == before["nodes"], "nodes duplicated on re-run"
    assert after["causal_edges"] == before["causal_edges"], "edges duplicated on re-run"
    assert after["clusters"] == before["clusters"], "clusters duplicated on re-run"
    assert after["evidence_objects"] == 2 * before["evidence_objects"], (
        "second run must APPEND a fresh evidence row set, not replace"
    )

    # Every run-1 evidence row still exists with its original value (no UPDATE/DELETE).
    cur.execute(
        "select evidence_id, lift from public.evidence_objects where scope_id=%s", (SCOPE,)
    )
    now_rows = {eid: lift for eid, lift in cur.fetchall()}
    for eid, lift in run1_rows.items():
        assert eid in now_rows, f"run-1 evidence row {eid} vanished — not append-only"
        assert now_rows[eid] == lift, f"run-1 evidence row {eid} was mutated — not append-only"

    # Beliefs still converge (idempotent): A stays 1.0/POSITIVE, C stays withheld.
    _, dir_a, score_a, _, _, _ = _action_edge(cur, ACTION_A)
    assert dir_a == "POSITIVE" and score_a == pytest.approx(1.0)
    _, _, score_c, reason_c, _, _ = _action_edge(cur, ACTION_C)
    assert score_c is None and reason_c == "INSUFFICIENT_HISTORY"
