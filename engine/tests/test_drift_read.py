"""DB round-trip gate for the drift read seam (persistence/drift_read.py).

Live local-Supabase integration, mirroring test_resolve's harness: seed a tenant
with a metric whose baseline slides in the pre-intervention window, then read
drift AS the RLS-scoped owner. Proves the persistence wiring end-to-end —
window derivation (commit_at + shipped-lever bound), the FIRED payload, the
declared-metric NO_BASELINE_YET path, the unresolved-only scope filter, and
cross-scope invisibility (a foreign prediction is simply None).

The lever-shipped case re-proves the correctness crux through the DB: a metric
whose ONLY structure is a step at the lever's ship date reads NOT_FIRED, because
the window stops at the ship date — the lever's effect is not drift.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import date, timedelta

import numpy as np
import psycopg
import pytest

from persistence.drift_read import read_prediction_drift, read_scope_drift

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

ORG = uuid.UUID("d21f0000-0000-0000-0000-0000000000a1")
PROJ = uuid.UUID("d21f0000-0000-0000-0000-0000000000a2")
WS = uuid.UUID("d21f0000-0000-0000-0000-0000000000a3")
USER = uuid.UUID("d21f0000-0000-0000-0000-0000000000a9")
ORG_F = uuid.UUID("d21f0000-0000-0000-0000-0000000000b1")
PROJ_F = uuid.UUID("d21f0000-0000-0000-0000-0000000000b2")
WS_F = uuid.UUID("d21f0000-0000-0000-0000-0000000000b3")
USER_F = uuid.UUID("d21f0000-0000-0000-0000-0000000000b9")

M_DRIFT = uuid.UUID("d21f0000-0000-0000-0000-00000000c001")   # baseline slides -> FIRED
M_LEVER = uuid.UUID("d21f0000-0000-0000-0000-00000000c002")   # step at ship date -> NOT_FIRED
M_DECLARED = uuid.UUID("d21f0000-0000-0000-0000-00000000c003")  # no obs -> NO_BASELINE_YET

A_UNSHIPPED = uuid.UUID("d21f0000-0000-0000-0000-00000000d001")
A_SHIPPED = uuid.UUID("d21f0000-0000-0000-0000-00000000d002")

D_DRIFT = uuid.UUID("d21f0000-0000-0000-0000-00000000e001")
D_LEVER = uuid.UUID("d21f0000-0000-0000-0000-00000000e002")
D_DECLARED = uuid.UUID("d21f0000-0000-0000-0000-00000000e003")
P_DRIFT = uuid.UUID("d21f0000-0000-0000-0000-00000000f001")
P_LEVER = uuid.UUID("d21f0000-0000-0000-0000-00000000f002")
P_DECLARED = uuid.UUID("d21f0000-0000-0000-0000-00000000f003")

SERIES_START = date(2025, 1, 1)
SERIES_DAYS = 120
SHIFT_AT = 60      # baseline slide index (M_DRIFT)
SHIP_AT = 80       # lever ship index (M_LEVER: the only step is here)


def _dates():
    return [SERIES_START + timedelta(days=i) for i in range(SERIES_DAYS)]


def _drift_values():
    rng = np.random.default_rng(7)
    v = 20.0 + rng.normal(0.0, 0.3, SERIES_DAYS)
    v[SHIFT_AT:] -= 8.0   # 20 -> 12 baseline slide
    return v


def _lever_effect_values():
    rng = np.random.default_rng(8)
    v = 20.0 + rng.normal(0.0, 0.3, SERIES_DAYS)
    v[SHIP_AT:] += 6.0    # the lever WORKED — a step at its ship date, nothing else
    return v


def _superuser_conn():
    conn = psycopg.connect(DSN)
    conn.autocommit = True
    return conn


@contextlib.contextmanager
def as_user(user_id):
    conn = psycopg.connect(DSN)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        yield conn
    finally:
        conn.close()


def _teardown(conn):
    with conn.cursor() as cur:
        cur.execute("delete from public.orgs where org_id = any(%s)", ([ORG, ORG_F],))
        cur.execute("delete from auth.users where id = any(%s)", ([USER, USER_F],))


def _obs(cur, metric_id, values):
    cur.executemany(
        "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
        [(metric_id, d, round(float(v), 4)) for d, v in zip(_dates(), values)])


def _seed(conn):
    with conn.cursor() as cur:
        for uid in (USER, USER_F):
            cur.execute("insert into auth.users (id) values (%s)", (uid,))
        cur.execute("insert into public.orgs (org_id, name) values (%s,%s),(%s,%s)",
                    (ORG, "DRIFT_TEST", ORG_F, "DRIFT_TEST_F"))
        cur.execute("insert into public.projects (project_id, org_id, name) "
                    "values (%s,%s,'p'),(%s,%s,'p')", (PROJ, ORG, PROJ_F, ORG_F))
        cur.execute("insert into public.workspaces (workspace_id, project_id, name) "
                    "values (%s,%s,'w'),(%s,%s,'w')", (WS, PROJ, WS_F, PROJ_F))
        cur.execute("insert into public.memberships (user_id, org_id, role) "
                    "values (%s,%s,'owner'),(%s,%s,'owner')", (USER, ORG, USER_F, ORG_F))

        cur.execute("insert into public.metrics (metric_id, scope_id, name, source, unit) "
                    "values (%s,%s,'Drift Metric','csv','percent')", (M_DRIFT, WS))
        cur.execute("insert into public.metrics (metric_id, scope_id, name, source, unit) "
                    "values (%s,%s,'Lever Metric','csv','percent')", (M_LEVER, WS))
        cur.execute("insert into public.metrics (metric_id, scope_id, name, source, unit) "
                    "values (%s,%s,'Declared Metric','declared','percent')", (M_DECLARED, WS))
        _obs(cur, M_DRIFT, _drift_values())
        _obs(cur, M_LEVER, _lever_effect_values())  # M_DECLARED: intentionally no observations

        # The shipped lever ships at SHIP_AT on M_LEVER.
        ship_date = SERIES_START + timedelta(days=SHIP_AT)
        cur.execute(
            "insert into public.actions (action_id, scope_id, source, external_ref, "
            "ship_ts, effective_date, status) values "
            "(%s,%s,'github_pr','PR #A',null,null,'open'),"
            "(%s,%s,'github_pr','PR #B',%s,%s,'merged')",
            (A_UNSHIPPED, WS, A_SHIPPED, WS,
             f"{ship_date.isoformat()}T12:00:00+00:00", ship_date))

        commit_at = f"{SERIES_START.isoformat()}T12:00:00+00:00"
        future = SERIES_START + timedelta(days=400)
        for did, pid, metric, lever, lever_status in (
            (D_DRIFT, P_DRIFT, M_DRIFT, A_UNSHIPPED, "DETECTED"),
            (D_LEVER, P_LEVER, M_LEVER, A_SHIPPED, "SHIPPED"),
            (D_DECLARED, P_DECLARED, M_DECLARED, A_UNSHIPPED, "DETECTED"),
        ):
            cur.execute("insert into public.decisions (decision_id, scope_id, title, created_by) "
                        "values (%s,%s,'d',%s)", (did, WS, USER))
            cur.execute("insert into public.levers (scope_id, decision_id, action_id, metric_id, "
                        "provenance_token, target_source, status) "
                        "values (%s,%s,%s,%s,%s,'github',%s)",
                        (WS, did, lever, metric, f"tok-{pid}", lever_status))
            cur.execute(
                "insert into public.predictions (prediction_id, scope_id, decision_id, "
                "metric_id, direction, magnitude_pct_mean, resolution_date, committed_at) "
                "values (%s,%s,%s,%s,'POSITIVE',3.0,%s,%s)",
                (pid, WS, did, metric, future, commit_at))


@pytest.fixture(scope="module")
def seeded():
    conn = _superuser_conn()
    _teardown(conn)
    _seed(conn)
    try:
        yield conn
    finally:
        _teardown(conn)
        conn.close()


def test_fires_on_baseline_slide(seeded):
    with as_user(USER) as conn:
        d = read_prediction_drift(conn, P_DRIFT)
    assert d is not None and d.status == "FIRED"
    assert d.direction == "down"
    assert d.pre_level == pytest.approx(20.0, abs=0.3)
    assert d.post_level == pytest.approx(12.0, abs=0.3)
    assert d.ci_high is not None and d.ci_high < 0.0
    assert d.shift_ordinal == pytest.approx((SERIES_START + timedelta(days=SHIFT_AT)).toordinal(), abs=3)


def test_lever_effect_not_flagged_via_ship_bound(seeded):
    # The metric's only structure is the lever's step at its ship date; the window
    # [commit, ship) excludes it, so drift must NOT fire.
    with as_user(USER) as conn:
        d = read_prediction_drift(conn, P_LEVER)
    assert d is not None and d.status == "NOT_FIRED"


def test_declared_metric_no_baseline_yet(seeded):
    with as_user(USER) as conn:
        d = read_prediction_drift(conn, P_DECLARED)
    assert d is not None and d.status == "NO_BASELINE_YET"
    assert d.reason == "no_observations"


def test_scope_read_covers_unresolved_predictions(seeded):
    with as_user(USER) as conn:
        drift = read_scope_drift(conn, WS)
    assert drift[str(P_DRIFT)].status == "FIRED"
    assert drift[str(P_LEVER)].status == "NOT_FIRED"
    assert drift[str(P_DECLARED)].status == "NO_BASELINE_YET"


def test_cross_scope_prediction_is_invisible(seeded):
    # The foreign owner cannot see this scope's prediction — a None, never a leak.
    with as_user(USER_F) as conn:
        assert read_prediction_drift(conn, P_DRIFT) is None
        assert read_scope_drift(conn, WS) == {}
