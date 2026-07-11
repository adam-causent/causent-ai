"""Verdict machine + resolution runner gate (epic #6, child #8).

Two layers:

  UNIT — the pure verdict machine (pre_verdict / verdict_for /
  predicted_native_value / pre_window_mean_for) exercised with synthetic
  belief-table states: all 8 verdicts, sign-primary + in-CI bonus semantics,
  the native/pct conversion contract, and the duplicate-lever raise.

  INTEGRATION — live DB gate (local Supabase, like test_bridge_e2e): a seeded
  tenant with one metric (120 daily points, +40 step at index 50) and levers
  placed to force each belief-table state through the REAL bridge, then
  resolve_due_predictions() as the RLS-scoped owner. Asserts the persisted
  verdicts, the memory tuple, GATHERING's date extension, idempotent re-runs,
  the loud duplicate-lever raise with no partial write, and cross-scope
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
from persistence.bridge import _load_metric
from persistence.resolve import (
    GATHERING_EXTENSION_DAYS,
    EdgeState,
    Lever,
    LeverConflictError,
    ResolutionResult,
    pre_verdict,
    pre_window_mean_for,
    predicted_native_value,
    resolve_due_predictions,
    resolve_prediction,
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


def _lever(effective=date(2026, 2, 20)):
    return Lever(uuid.uuid4(), "PR #1", effective)


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


# --- the duplicate-lever raise ------------------------------------------------

def test_two_levers_for_one_decision_metric_raise_loudly():
    with pytest.raises(LeverConflictError):
        pre_verdict([_lever(), _lever()], TODAY)


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
D_DUP = uuid.UUID("f0f0e000-0000-0000-0000-0000000000d7")

P_CONF = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e0")
P_DIR = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e1")
P_REF = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e2")
P_INC = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e3")
P_GATH = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e4")
P_VOID = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e5")
P_UNATTR = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e6")
P_DUP = uuid.UUID("f0f0e000-0000-0000-0000-0000000000e7")

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
            (D_UNATTR, "Unattributed decision"), (D_DUP, "Duplicate-lever decision"),
        ]
        for decision_id, title in decisions:
            cur.execute(
                "insert into public.decisions (decision_id, scope_id, title, rationale) "
                "values (%s,%s,%s,%s)",
                (decision_id, WS, title,
                 json.dumps({"meta": {"mechanism_category": "conversion-funnel"}})))

        links = [
            (D_CONF, ACT_LEVER, True), (D_DIR, ACT_LEVER, True), (D_REF, ACT_LEVER, True),
            (D_INC, ACT_FLAT, True), (D_GATH, ACT_LATE, True), (D_VOID, ACT_NEVER, True),
            (D_UNATTR, ACT_FLAT, False),               # mapped but NOT a lever
            (D_DUP, ACT_LEVER, True), (D_DUP, ACT_FLAT, True),  # invariant broken
        ]
        for decision_id, action_id, is_lever in links:
            cur.execute(
                "insert into public.decision_actions (decision_id, action_id, is_lever) "
                "values (%s,%s,%s)",
                (decision_id, action_id, is_lever))

    # Oracle: the engine's own readout of the DB-roundtripped series, so the
    # CONFIRMED magnitude is dead-center in the measured CI by construction.
    loaded = _load_metric(conn, METRIC)
    oracle = its_readout(Series(loaded.series.dates, loaded.series.values, STEP_AT))
    assert oracle.status == "OK" and oracle.lift is not None
    pre_mean = float(np.nanmean(loaded.series.values[:STEP_AT]))
    oracle_pct = oracle.lift / abs(pre_mean) * 100.0

    with conn.cursor() as cur:
        predictions = [
            (P_CONF, D_CONF, "POSITIVE", oracle_pct, DUE),
            (P_DIR, D_DIR, "POSITIVE", oracle_pct * 3.0, DUE),
            (P_REF, D_REF, "NEGATIVE", oracle_pct, DUE),
            (P_INC, D_INC, "POSITIVE", 5.0, DUE),
            (P_GATH, D_GATH, "POSITIVE", 5.0, DUE),
            (P_VOID, D_VOID, "POSITIVE", 5.0, DUE),
            (P_UNATTR, D_UNATTR, "POSITIVE", 5.0, DUE),
            (P_DUP, D_DUP, "POSITIVE", 5.0, NOT_DUE),
        ]
        for pid, decision_id, direction, magnitude, due in predictions:
            cur.execute(
                "insert into public.predictions (prediction_id, scope_id, decision_id, "
                "metric_id, direction, magnitude_pct_mean, resolution_date) "
                "values (%s,%s,%s,%s,%s,%s,%s)",
                (pid, WS, decision_id, direction, magnitude, due)
                if False else
                (pid, WS, decision_id, METRIC, direction, magnitude, due))
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


def test_e2e_duplicate_lever_raises_with_no_partial_write(resolved):
    conn, _, _ = resolved
    with as_user(USER) as user_conn:
        with pytest.raises(LeverConflictError):
            resolve_prediction(user_conn, P_DUP, today=TODAY, force=True)
    verdict, resolved_at, edge_id, _, tup = _verdict_row(conn, P_DUP)
    assert (verdict, resolved_at, edge_id, tup) == (None, None, None, None)


def test_e2e_cross_scope_prediction_invisible_and_untouched(resolved):
    conn, _, _ = resolved
    with as_user(USER_F) as foreign_conn:
        result = resolve_prediction(foreign_conn, P_DUP, today=TODAY, force=True)
        assert result.status == "SKIPPED_NOT_VISIBLE"
        sweep = resolve_due_predictions(foreign_conn, WS, today=TODAY)
        assert sweep == []
    assert _verdict_row(conn, P_DUP)[0] is None
