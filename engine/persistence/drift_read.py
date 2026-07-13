"""Compute-on-read surfacing of baseline drift for a prediction (C5/#18).

The detector (causal/drift.py) is pure; this is the thin persistence seam that
feeds it real data through the caller's RLS-scoped connection — exactly the
bridge contract (never the service role; a foreign prediction is invisible).
NO drift-persistence migration for the demo: drift is recomputed on every read,
so a Restate (which changes only the committed magnitude, not the metric's
baseline) leaves the notice correct without any stored-drift bookkeeping.

The pre-intervention window is derived here: `commit_ordinal` from the
prediction's committed_at, and `ship_ordinal` from the earliest lever that has
actually SHIPPED for this (decision, metric). When no lever has shipped — the
common prospective case, and the seeded demo — ship is None and drift is searched
over the whole post-commit tail. This is the boundary that keeps a lever's own
effect from ever reading as drift (see causal/drift.py).
"""

from __future__ import annotations

from uuid import UUID

from psycopg import Connection

from causal.drift import detect_baseline_drift
from causal.types import DriftResult
from persistence.bridge import _load_metric
from persistence.resolve import _levers_for

Id = UUID | str


def _ship_ordinal(conn: Connection, decision_id: Id, metric_id: Id) -> int | None:
    """The earliest SHIPPED lever's effective-date ordinal for this (decision,
    metric) — the upper bound of the pre-intervention window. None when no lever
    has shipped (unshipped / DETECTED / DROPPED), i.e. the prospective case."""
    shipped = [
        lv.effective_date
        for lv in _levers_for(conn, decision_id, metric_id)
        if lv.status == "SHIPPED" and lv.effective_date is not None
    ]
    return min(shipped).toordinal() if shipped else None


def read_prediction_drift(conn: Connection, prediction_id: Id) -> DriftResult | None:
    """Baseline drift for one prediction, computed on read. None when the
    prediction is not visible under this connection's RLS scope."""
    pid = UUID(str(prediction_id))
    row = conn.execute(
        "select decision_id, metric_id, committed_at from public.predictions "
        "where prediction_id = %s",
        (pid,),
    ).fetchone()
    if row is None:
        return None
    decision_id, metric_id, committed_at = row

    metric = _load_metric(conn, metric_id)
    if metric is None:
        # A declared metric that never received observations — no baseline to move.
        return DriftResult("NO_BASELINE_YET", reason="no_observations")

    commit_ordinal = committed_at.date().toordinal()
    ship_ordinal = _ship_ordinal(conn, decision_id, metric_id)
    # metric.series already carries the sorted ordinal dates + float values
    # (NULL -> NaN); the detector chooses its own change-point splits inside it.
    return detect_baseline_drift(metric.series, commit_ordinal, ship_ordinal)


def read_scope_drift(conn: Connection, scope_id: Id) -> dict[str, DriftResult]:
    """Baseline drift for every UNRESOLVED prediction in the scope. The notice is
    a live signal on an open belief; a resolved prediction's record already
    stands, so it is skipped. Keyed by prediction_id (str) for the read layer."""
    rows = conn.execute(
        "select prediction_id from public.predictions "
        "where scope_id = %s and resolved_at is null "
        "order by prediction_id",
        (scope_id,),
    ).fetchall()
    out: dict[str, DriftResult] = {}
    for (pid,) in rows:
        drift = read_prediction_drift(conn, pid)
        if drift is not None:
            out[str(pid)] = drift
    return out
