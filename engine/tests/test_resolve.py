"""Verdict machine + resolution runner gate (epic #6, child #8).

Two layers:

  UNIT — the pure verdict machine (pre_verdict / verdict_for /
  predicted_native_value / pre_window_mean_for / shipped_levers /
  ship_span_days) exercised with synthetic belief-table states: all verdicts,
  sign-primary + in-CI bonus semantics, the native/pct conversion contract,
  and the multi-lever cluster-window derivation + ship-span guard (C4/#17).

  INTEGRATION — live DB gate (local Supabase, like test_bridge_e2e): a seeded
  tenant with one metric (120 daily points, +40 step at index 50) and levers
  placed to force each belief-table state through the REAL bridge, then
  resolve_due_predictions() as the RLS-scoped owner. Asserts the persisted
  verdicts, the memory tuple, GATHERING's date extension, idempotent re-runs,
  the multi-lever cluster path (CLUSTER edge, window, span guard, all-dropped
  VOIDED, declared-metric UNMEASURABLE_NO_METRIC), and cross-scope
  invisibility under RLS.

The CONFIRMED prediction's magnitude is derived from the engine's own oracle
readout of the seeded series (lift / pre-mean), so the in-CI bonus is exercised
deterministically without hardcoding a fragile magic number. That is a test
fixture technique only — production predictions are always human-authored
(elicit-not-assert).
"""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import date, timedelta

import numpy as np
import psycopg
import pytest

from causal.its_readout import its_readout
from causal.types import Series
from persistence.bridge import CLUSTER_POST_WINDOW, _load_metric
from persistence.resolve import (
    GATHERING_EXTENSION_DAYS,
    MAX_CLUSTER_SPAN_DAYS,
    EdgeState,
    Lever,
    ResolutionResult,
    pre_verdict,
    pre_window_mean_for,
    predicted_native_value,
    resolve_due_predictions,
    resolve_prediction,
    ship_span_days,
    shipped_levers,
    verdict_for,
)

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

TODAY = date(2026, 5, 1)

# ============================================================================
# UNIT — the pure verdict machine
# ============================================================================

POS = "POSITIVE"
NEG = "NEGATIVE"


def _edge(direction=POS, belief=1.0, reason=None, lift=40.0, ci=(38.0, 42.0)):
    return EdgeState(
        direction=direction, belief_score=belief, belief_reason=reason,
        lift=lift, ci_low=ci[0], ci_high=ci[1],
    )


def _lever(effective=date(2026, 2, 20), status="SHIPPED", action_id=None):
    return Lever(action_id or uuid.uuid4(), "PR #1", effective, status)


# --- the 8 verdicts, one belief-table state each -----------------------------

def test_confirmed_direction_match_and_native_in_ci():
    assert verdict_for(_edge(), POS, 40.0) == "CONFIRMED"


def test_direction_confirmed_native_outside_ci():
    assert verdict_for(_edge(), POS, 120.0) == "DIRECTION_CONFIRMED"


def test_refuted_on_opposite_direction():
    assert verdict_for(_edge(direction=POS), NEG, -40.0) == "REFUTED"


def test_inconclusive_on_half_belief():
    assert verdict_for(_edge(belief=0.5, ci=(-2.0, 3.0)), POS, 1.0) == "INCONCLUSIVE"


def test_gathering_on_insufficient_history():
    e = _edge(direction="INCONCLUSIVE", belief=None, reason="INSUFFICIENT_HISTORY",
              lift=None, ci=(None, None))
    assert verdict_for(e, POS, 1.0) == "GATHERING"


def test_unresolvable_on_degenerate():
    e = _edge(direction="INCONCLUSIVE", belief=None, reason="DEGENERATE",
              lift=None, ci=(None, None))
    assert verdict_for(e, POS, 1.0) == "UNRESOLVABLE"


def test_voided_when_lever_never_shipped():
    assert pre_verdict([_lever(effective=None)], TODAY) == "VOIDED"
    # shipped-in-the-future at resolution time is also not shipped
    assert pre_verdict([_lever(effective=TODAY + timedelta(days=30))], TODAY) == "VOIDED"


def test_unattributed_when_no_lever():
    assert pre_verdict([], TODAY) == "UNATTRIBUTED"


# --- sign-primary + in-CI bonus semantics ------------------------------------

def test_sign_primary_right_direction_wrong_size_is_not_refuted():
    # 3x too big — right way, off on size. NOT a failure of direction.
    assert verdict_for(_edge(), POS, 120.0) == "DIRECTION_CONFIRMED"


def test_sign_primary_opposite_direction_close_magnitude_still_refuted():
    # |predicted| lands numerically near the CI but the sign is wrong: REFUTED.
    assert verdict_for(_edge(direction=NEG, ci=(-42.0, -38.0), lift=-40.0), POS, 40.0) \
        == "REFUTED"


def test_in_ci_bonus_boundary_is_inclusive():
    assert verdict_for(_edge(ci=(38.0, 42.0)), POS, 38.0) == "CONFIRMED"
    assert verdict_for(_edge(ci=(38.0, 42.0)), POS, 42.0) == "CONFIRMED"
    assert verdict_for(_edge(ci=(38.0, 42.0)), POS, 37.99) == "DIRECTION_CONFIRMED"


def test_zero_belief_is_inconclusive_not_refuted():
    # placebo-falsified (belief 0.0) is "no credible signal", never REFUTED
    assert verdict_for(_edge(belief=0.0, reason="PLACEBO"), NEG, -40.0) == "INCONCLUSIVE"


def test_missing_edge_is_gathering():
    assert verdict_for(None, POS, 1.0) == "GATHERING"


# --- the native/pct conversion contract --------------------------------------

def test_pre_window_mean_uses_exactly_the_its_pre_points():
    values = np.array([10.0] * 50 + [99.0] * 50)
    assert pre_window_mean_for(values, 50) == pytest.approx(10.0)
    assert pre_window_mean_for(values, 0) is None


def test_pre_window_mean_is_nan_tolerant():
    values = np.array([10.0, np.nan, 14.0, 99.0])
    assert pre_window_mean_for(values, 3) == pytest.approx(12.0)
    assert pre_window_mean_for(np.array([np.nan, np.nan]), 2) is None


def test_predicted_native_signs_by_direction():
    assert predicted_native_value(5.0, POS, 200.0) == pytest.approx(10.0)
    assert predicted_native_value(5.0, NEG, 200.0) == pytest.approx(-10.0)
    assert predicted_native_value(5.0, POS, None) is None


def test_predicted_native_uses_abs_denominator():
    # a negative pre-mean must not flip the predicted sign
    assert predicted_native_value(5.0, POS, -200.0) == pytest.approx(10.0)


# --- multi-lever: cluster-window derivation + ship-span guard (C4/#17) --------

def test_shipped_levers_filter_dedupe_and_order():
    # The cluster's members: SHIPPED-with-a-ship-date-by-today only, deduped by
    # action, sorted by ship date — so [0]'s ship date IS the cluster's single
    # intervention (its window opens there).
    a_early, a_late = uuid.uuid4(), uuid.uuid4()
    early = _lever(effective=date(2026, 2, 1), action_id=a_early)
    late = _lever(effective=date(2026, 2, 10), action_id=a_late)
    ignored = [
        _lever(status="DROPPED"),                                # dropped
        _lever(effective=None, status="CREATED"),                # never shipped
        _lever(effective=TODAY + timedelta(days=5)),             # future ship
        _lever(effective=date(2026, 2, 3), action_id=a_early),   # dup action
    ]
    shipped = shipped_levers([late, *ignored, early], TODAY)
    assert [lv.action_id for lv in shipped] == [a_early, a_late]
    assert shipped[0].effective_date == date(2026, 2, 1)
    assert ship_span_days(shipped) == 9
    assert ship_span_days(shipped[:1]) == 0


def test_ship_span_guard_boundary_is_inclusive():
    # span == MAX_CLUSTER_SPAN_DAYS still clusters; one day beyond refuses.
    first = _lever(effective=date(2026, 2, 1))
    at_max = _lever(
        effective=date(2026, 2, 1) + timedelta(days=MAX_CLUSTER_SPAN_DAYS))
    beyond = _lever(
        effective=date(2026, 2, 1) + timedelta(days=MAX_CLUSTER_SPAN_DAYS + 1))
    assert pre_verdict([first, at_max], TODAY) is None
    assert pre_verdict([first, beyond], TODAY) == "UNRESOLVABLE"


def test_all_dropped_or_unshipped_levers_are_voided():
    # Levers exist but none count toward an intervention: VOIDED, even when a
    # DROPPED lever's ticket had shipped before being dropped.
    assert pre_verdict(
        [_lever(status="DROPPED"), _lever(effective=None, status="CREATED")],
        TODAY,
    ) == "VOIDED"


def test_two_shipped_levers_within_span_proceed_to_measurement():
    assert pre_verdict([_lever(), _lever(effective=date(2026, 2, 25))], TODAY) is None


# ============================================================================
# INTEGRATION — live DB gate (local Supabase; mirrors test_bridge_e2e)
# ============================================================================

ORG = uuid.UUID("f0f0e000-0000-0000-0000-0000000000a0")
PROJ = uuid.UUID("f0f0e000-0000-0000-0000-0000000000a1")
WS = uuid.UUID("f0f0e000-0000-0000-0000-0000000000a2")
USER = uuid.UUID("f0f0e111-0000-0000-0000-0000000000a9")

ORG_F = uuid.UUID("f0f0f000-0000-0000-0000-0000000000b0")
PROJ_F = uuid.UUID("f0f0f000-0000-0000-0000-0000000000b1")
WS_F = uuid.UUID("f0f0f000-0000-0000-0000-0000000000b2")
USER_F = uuid.UUID("f0f0f111-0000-0000-0000-0000000000b9")  # foreign: no grant on WS

METRIC = uuid.UUID("f0f0e000-0000-0000-0000-0000000000c0")
METRIC_DECL = uuid.UUID("f0f0e000-0000-0000-0000-0000000000c5")  # declared, no obs

ACT_LEVER = uuid.UUID("f0f0e000-0000-0000-0000-0000000000c1")   # split 50: belief 1.0
ACT_FLAT = uuid.UUID("f0f0e000-0000-0000-0000-0000000000c2")    # split 74: CI incl 0
ACT_LATE = uuid.UUID("f0f0e000-0000-0000-0000-0000000000c3")    # split 100: <45 post
ACT_NEVER = uuid.UUID("f0f0e000-0000-0000-0000-0000000000c4")   # never shipped

# one decision per scenario so each prediction resolves an unambiguous lever
D_CONF = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d0")
D_DIR = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d1")
D_REF = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d2")
D_INC = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d3")
D_GATH = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d4")
D_VOID = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d5")
D_UNATTR = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d6")
D_PEND = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d7")  # multi-lever, not yet due
D_CLUS = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d8")  # cluster path (span ok)
D_SPAN = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d9")  # ships too far apart
D_DROP = uuid.UUID("f0f0e000-0000-0000-0000-0000000000da")  # all levers dropped
D_NOM = uuid.UUID("f0f0e000-0000-0000-0000-0000000000db")   # declared metric, no obs

P_CONF = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e0")
P_DIR = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e1")
P_REF = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e2")
P_INC = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e3")
P_GATH = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e4")
P_VOID = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e5")
P_UNATTR = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e6")
P_PEND = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e7")
P_CLUS = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e8")
P_SPAN = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e9")
P_DROP = uuid.UUID("f0f0e000-0000-0000-0000-0000000000ea")
P_NOM = uuid.UUID("f0f0e000-0000-0000-0000-0000000000eb")

SERIES_START = date(2026, 1, 1)
SERIES_DAYS = 120
STEP_AT = 50
STEP = 40.0

DUE = date(2026, 4, 30)          # <= TODAY: swept
NOT_DUE = date(2026, 6, 1)       # > TODAY: only reachable with force=True


def _day(i: int) -> date:
    return SERIES_START + timedelta(days=i)


def _superuser_conn() -> psycopg.Connection:
    conn = psycopg.connect(DSN)
    conn.autocommit = True
    return conn


@contextlib.contextmanager
def as_user(user_id: uuid.UUID, autocommit: bool = False):
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


def _teardown(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from public.orgs where org_id = any(%s)", ([ORG, ORG_F],))
        cur.execute("delete from auth.users where id = any(%s)", ([USER, USER_F],))


def _series_values() -> np.ndarray:
    rng = np.random.default_rng(42)
    values = 100.0 + rng.normal(0.0, 2.0, SERIES_DAYS)
    values[STEP_AT:] += STEP
    return values


def _seed(conn: psycopg.Connection) -> float:
    """Seed the tenant + fixtures. Returns the oracle %-of-pre-mean magnitude
    that lands the CONFIRMED prediction's native value inside the measured CI."""
    values = _series_values()
    with conn.cursor() as cur:
        for uid in (USER, USER_F):
            cur.execute("insert into auth.users (id) values (%s)", (uid,))
        cur.execute("insert into public.orgs (org_id, name) values (%s,%s),(%s,%s)",
                    (ORG, "RESOLVE_TEST_org", ORG_F, "RESOLVE_TEST_org_foreign"))
        cur.execute(
            "insert into public.projects (project_id, org_id, name) values (%s,%s,%s),(%s,%s,%s)",
            (PROJ, ORG, "p", PROJ_F, ORG_F, "p"))
        cur.execute(
            "insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,%s),(%s,%s,%s)",
            (WS, PROJ, "w", WS_F, PROJ_F, "w"))
        cur.execute(
            "insert into public.memberships (user_id, org_id, role) values (%s,%s,'owner'),(%s,%s,'owner')",
            (USER, ORG, USER_F, ORG_F))

        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source, unit) "
            "values (%s,%s,'Resolve Gate Metric','csv','count')",
            (METRIC, WS))
        # Declared metric (C1/#14): name-only, NO observations — the funnel's
        # cold-start substrate. Resolution must say UNMEASURABLE_NO_METRIC.
        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source, unit) "
            "values (%s,%s,'Declared Unwired Metric','declared','count')",
            (METRIC_DECL, WS))
        cur.executemany(
            "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
            [(METRIC, _day(i), float(v)) for i, v in enumerate(values)])

        actions = [
            (ACT_LEVER, "PR #9001", _day(STEP_AT)),
            (ACT_FLAT, "PR #9002", _day(74)),
            (ACT_LATE, "PR #9003", _day(100)),
            (ACT_NEVER, "PR #9004", None),
        ]
        for action_id, ref, eff in actions:
            cur.execute(
                "insert into public.actions (action_id, scope_id, source, external_ref, effective_date) "
                "values (%s,%s,'github_pr',%s,%s)",
                (action_id, WS, ref, eff))

        decisions = [
            (D_CONF, "Confirmed decision"), (D_DIR, "Direction-only decision"),
            (D_REF, "Refuted decision"), (D_INC, "Inconclusive decision"),
            (D_GATH, "Gathering decision"), (D_VOID, "Voided decision"),
            (D_UNATTR, "Unattributed decision"), (D_PEND, "Pending multi-lever decision"),
            (D_CLUS, "Cluster-path decision"), (D_SPAN, "Span-guard decision"),
            (D_DROP, "All-levers-dropped decision"), (D_NOM, "Declared-metric decision"),
        ]
        for decision_id, title in decisions:
            cur.execute(
                "insert into public.decisions (decision_id, scope_id, title, rationale) "
                "values (%s,%s,%s,%s)",
                (decision_id, WS, title,
                 json.dumps({"meta": {"mechanism_category": "conversion-funnel"}})))

        # An action is a lever iff it has a levers row (C1/#14); decision_actions
        # keeps the plain decision->action linkage. lever_metric None = mapped
        # but NOT a lever.
        links = [
            (D_CONF, ACT_LEVER, METRIC, "SHIPPED"),
            (D_DIR, ACT_LEVER, METRIC, "SHIPPED"),
            (D_REF, ACT_LEVER, METRIC, "SHIPPED"),
            (D_INC, ACT_FLAT, METRIC, "SHIPPED"),
            (D_GATH, ACT_LATE, METRIC, "SHIPPED"),
            (D_VOID, ACT_NEVER, METRIC, "CREATED"),     # never shipped
            (D_UNATTR, ACT_FLAT, None, None),           # mapped but NOT a lever
            # same-metric multi-lever, prediction not yet due (stays unresolved)
            (D_PEND, ACT_LEVER, METRIC, "SHIPPED"),
            (D_PEND, ACT_FLAT, METRIC, "SHIPPED"),
            # cluster path: ships day 50 + day 74 (span 24 <= MAX 28)
            (D_CLUS, ACT_LEVER, METRIC, "SHIPPED"),
            (D_CLUS, ACT_FLAT, METRIC, "SHIPPED"),
            # span guard: ships day 50 + day 100 (span 50 > MAX 28)
            (D_SPAN, ACT_LEVER, METRIC, "SHIPPED"),
            (D_SPAN, ACT_LATE, METRIC, "SHIPPED"),
            # all levers dropped (one of them HAD shipped before the drop)
            (D_DROP, ACT_LEVER, METRIC, "DROPPED"),
            (D_DROP, ACT_FLAT, METRIC, "DROPPED"),
            # declared metric with no observations; the lever itself shipped
            (D_NOM, ACT_LEVER, METRIC_DECL, "SHIPPED"),
        ]
        for i, (decision_id, action_id, lever_metric, status) in enumerate(links):
            cur.execute(
                "insert into public.decision_actions (decision_id, action_id) "
                "values (%s,%s) on conflict do nothing",
                (decision_id, action_id))
            if lever_metric is not None:
                cur.execute(
                    "insert into public.levers (scope_id, decision_id, action_id, "
                    "metric_id, provenance_token, target_source, status) "
                    "values (%s,%s,%s,%s,%s,'github',%s)",
                    (WS, decision_id, action_id, lever_metric,
                     f"resolve-lever-{i}", status))

    # Oracle: the engine's own readout of the DB-roundtripped series, so the
    # CONFIRMED magnitude is dead-center in the measured CI by construction.
    loaded = _load_metric(conn, METRIC)
    oracle = its_readout(Series(loaded.series.dates, loaded.series.values, STEP_AT))
    assert oracle.status == "OK" and oracle.lift is not None
    pre_mean = float(np.nanmean(loaded.series.values[:STEP_AT]))
    oracle_pct = oracle.lift / abs(pre_mean) * 100.0

    with conn.cursor() as cur:
        predictions = [
            (P_CONF, D_CONF, METRIC, "POSITIVE", oracle_pct, DUE),
            (P_DIR, D_DIR, METRIC, "POSITIVE", oracle_pct * 3.0, DUE),
            (P_REF, D_REF, METRIC, "NEGATIVE", oracle_pct, DUE),
            (P_INC, D_INC, METRIC, "POSITIVE", 5.0, DUE),
            (P_GATH, D_GATH, METRIC, "POSITIVE", 5.0, DUE),
            (P_VOID, D_VOID, METRIC, "POSITIVE", 5.0, DUE),
            (P_UNATTR, D_UNATTR, METRIC, "POSITIVE", 5.0, DUE),
            (P_PEND, D_PEND, METRIC, "POSITIVE", 5.0, NOT_DUE),
            # the cluster's intervention is the earliest ship (day 50), so the
            # oracle magnitude lands in the cluster edge's CI too
            (P_CLUS, D_CLUS, METRIC, "POSITIVE", oracle_pct, DUE),
            (P_SPAN, D_SPAN, METRIC, "POSITIVE", 5.0, DUE),
            (P_DROP, D_DROP, METRIC, "POSITIVE", 5.0, DUE),
            (P_NOM, D_NOM, METRIC_DECL, "POSITIVE", 5.0, DUE),
        ]
        for pid, decision_id, metric_id, direction, magnitude, due in predictions:
            cur.execute(
                "insert into public.predictions (prediction_id, scope_id, decision_id, "
                "metric_id, direction, magnitude_pct_mean, resolution_date) "
                "values (%s,%s,%s,%s,%s,%s,%s)",
                (pid, WS, decision_id, metric_id, direction, magnitude, due))
    return oracle_pct


@pytest.fixture(scope="module")
def resolved():
    """Seed, then run the due sweep once as the RLS-scoped owner."""
    conn = _superuser_conn()
    _teardown(conn)
    oracle_pct = _seed(conn)
    with as_user(USER) as user_conn:
        results = resolve_due_predictions(user_conn, WS, today=TODAY)
    try:
        yield conn, results, oracle_pct
    finally:
        _teardown(conn)
        conn.close()


def _verdict_row(conn, pid):
    return conn.execute(
        "select resolved_verdict, resolved_at, resolved_edge_id, resolution_date, "
        "resolution_tuple from public.predictions where prediction_id = %s",
        (pid,),
    ).fetchone()


# --- each verdict reachable end-to-end ---------------------------------------

def test_e2e_verdicts_land_as_seeded(resolved):
    conn, _, _ = resolved
    expected = {
        P_CONF: "CONFIRMED",
        P_DIR: "DIRECTION_CONFIRMED",
        P_REF: "REFUTED",
        P_INC: "INCONCLUSIVE",
        P_GATH: "GATHERING",
        P_VOID: "VOIDED",
        P_UNATTR: "UNATTRIBUTED",
        P_CLUS: "CONFIRMED",              # multi-lever via the cluster edge
        P_SPAN: "UNRESOLVABLE",           # ships too far apart to cluster
        P_DROP: "VOIDED",                 # every lever dropped
        P_NOM: "UNMEASURABLE_NO_METRIC",  # declared metric, no observations
    }
    got = {pid: _verdict_row(conn, pid)[0] for pid in expected}
    assert got == expected


def test_e2e_terminal_rows_fully_written(resolved):
    conn, _, _ = resolved
    verdict, resolved_at, edge_id, _, tup = _verdict_row(conn, P_CONF)
    assert verdict == "CONFIRMED"
    assert resolved_at is not None
    assert edge_id is not None
    assert tup["verdict"] == "CONFIRMED"


def test_e2e_gathering_extends_and_stays_open(resolved):
    conn, _, _ = resolved
    verdict, resolved_at, _, resolution_date, _ = _verdict_row(conn, P_GATH)
    assert verdict == "GATHERING"
    assert resolved_at is None, "GATHERING must not write a terminal resolution"
    assert resolution_date == TODAY + timedelta(days=GATHERING_EXTENSION_DAYS)


def test_e2e_memory_tuple_contents(resolved):
    conn, _, oracle_pct = resolved
    tup = _verdict_row(conn, P_CONF)[4]
    assert tup["predicted_direction"] == "POSITIVE"
    assert tup["measured_direction"] == "POSITIVE"
    assert tup["belief_score"] == 1.0
    assert tup["metric_name"] == "Resolve Gate Metric"
    assert tup["mechanism_category"] == "conversion-funnel"
    assert "PR #9001" in tup["action_labels"]
    assert tup["ci_low"] <= tup["predicted_native"] <= tup["ci_high"]
    assert tup["measured_pct"] == pytest.approx(oracle_pct, rel=1e-3)
    assert tup["predicted_magnitude_pct"] == pytest.approx(oracle_pct, rel=1e-4)


def test_e2e_voided_and_unattributed_have_no_edge(resolved):
    conn, _, _ = resolved
    for pid in (P_VOID, P_UNATTR):
        verdict, resolved_at, edge_id, _, tup = _verdict_row(conn, pid)
        assert resolved_at is not None
        assert edge_id is None
        assert tup["verdict"] == verdict


def test_e2e_rerun_is_idempotent(resolved):
    conn, _, _ = resolved
    before = {pid: _verdict_row(conn, pid) for pid in (P_CONF, P_REF, P_VOID)}
    with as_user(USER) as user_conn:
        second = resolve_due_predictions(user_conn, WS, today=TODAY)
    statuses = {r.prediction_id: r.status for r in second}
    for pid in (P_CONF, P_REF, P_VOID):
        # Terminal rows are excluded at the scan level (resolved_at is null),
        # so a second sweep never even returns them — and never rewrites them.
        assert pid not in statuses
        assert _verdict_row(conn, pid) == before[pid]
    # GATHERING re-measures — but its extended date is no longer due today.
    assert P_GATH not in statuses  # resolution_date moved past TODAY
    # Direct re-resolution of a terminal prediction IS a reported no-op.
    with as_user(USER) as user_conn:
        direct = resolve_prediction(user_conn, P_CONF, today=TODAY, force=True)
    assert direct.status == "SKIPPED_ALREADY_RESOLVED"
    assert _verdict_row(conn, P_CONF) == before[P_CONF]


# --- multi-lever cluster path (C4/#17) ----------------------------------------

def test_e2e_multi_lever_resolves_via_cluster_edge(resolved):
    # Two shipped levers on one metric, ships within the span window: the
    # prediction resolves against a CLUSTER -> METRIC edge measured as ONE
    # intervention at the earliest ship (day 50) — so the oracle magnitude
    # derived at split 50 lands CONFIRMED, same as the single-lever case.
    conn, _, _ = resolved
    verdict, resolved_at, edge_id, _, tup = _verdict_row(conn, P_CLUS)
    assert verdict == "CONFIRMED"
    assert resolved_at is not None and edge_id is not None
    assert tup["cluster_id"] is not None
    assert set(tup["lever_refs"]) == {"PR #9001", "PR #9002"}
    assert tup["ship_span_days"] == 24
    src_type = conn.execute(
        "select s.type from public.causal_edges e "
        "join public.nodes s on s.node_id = e.source_node_id "
        "where e.edge_id = %s", (edge_id,)).fetchone()[0]
    assert src_type == "CLUSTER"
    # the persisted cluster window: [earliest ship, latest ship + post-window]
    window = conn.execute(
        "select window_start, window_end from public.clusters where cluster_id = %s",
        (uuid.UUID(tup["cluster_id"]),)).fetchone()
    assert window == (_day(50), _day(74) + CLUSTER_POST_WINDOW)


def test_e2e_single_lever_tuple_shape_unchanged(resolved):
    # Regression: the single-lever memory tuple keeps its singular fields and
    # gains NO cluster fields (byte-for-byte path separation).
    conn, _, _ = resolved
    tup = _verdict_row(conn, P_CONF)[4]
    assert tup["lever_ref"] == "PR #9001"
    assert "cluster_id" not in tup and "lever_refs" not in tup


def test_e2e_ship_span_guard_unresolvable(resolved):
    # Ships 50 days apart (> MAX_CLUSTER_SPAN_DAYS): the co-occurrence premise
    # fails; the honest verdict is UNRESOLVABLE with no edge, not a forced fit.
    conn, results, _ = resolved
    verdict, resolved_at, edge_id, _, tup = _verdict_row(conn, P_SPAN)
    assert verdict == "UNRESOLVABLE"
    assert resolved_at is not None and edge_id is None
    assert tup["verdict"] == "UNRESOLVABLE"
    detail = {r.prediction_id: r.detail for r in results}[P_SPAN]
    assert "MAX_CLUSTER_SPAN_DAYS" in detail


def test_e2e_all_dropped_levers_voided(resolved):
    conn, _, _ = resolved
    verdict, resolved_at, edge_id, _, tup = _verdict_row(conn, P_DROP)
    assert verdict == "VOIDED"
    assert resolved_at is not None and edge_id is None


def test_e2e_declared_metric_no_observations_unmeasurable(resolved):
    # Declared metric, zero observations: UNMEASURABLE_NO_METRIC before any
    # ITS — no edge, no fabricated readout, lever presence notwithstanding.
    conn, results, _ = resolved
    verdict, resolved_at, edge_id, _, tup = _verdict_row(conn, P_NOM)
    assert verdict == "UNMEASURABLE_NO_METRIC"
    assert resolved_at is not None and edge_id is None
    assert tup["verdict"] == "UNMEASURABLE_NO_METRIC"
    # and no evidence/edge was ever materialized for the declared metric
    n_nodes = conn.execute(
        "select count(*) from public.nodes where semantic_ref = %s",
        (METRIC_DECL,)).fetchone()[0]
    assert n_nodes == 0


def test_e2e_cross_scope_prediction_invisible_and_untouched(resolved):
    conn, _, _ = resolved
    with as_user(USER_F) as foreign_conn:
        result = resolve_prediction(foreign_conn, P_PEND, today=TODAY, force=True)
        assert result.status == "SKIPPED_NOT_VISIBLE"
        sweep = resolve_due_predictions(foreign_conn, WS, today=TODAY)
        assert sweep == []
    assert _verdict_row(conn, P_PEND)[0] is None
