"""Resolution verdict machine + scorer (epic #6, child #8).

At a prediction's `resolution_date` the live ITS engine measures the lever
action -> metric edge; this module maps the ITS belief-table state onto one of
the 8 verdicts (docs/designs/prospective-prediction-loop.md) and persists the
memory tuple. It REUSES the bridge (persist_metric_readouts) to materialize the
edge through the real engine — it never re-implements ITS.

Verdict machine (belief table -> verdict):

    belief 1.0, direction matches, predicted-native in CI      CONFIRMED
    belief 1.0, direction matches, predicted-native outside CI DIRECTION_CONFIRMED
    belief 1.0, direction opposite                             REFUTED
    belief 0.0/0.5 (FDR / autocorr / CI-incl-0 / placebo)      INCONCLUSIVE
    belief NULL INSUFFICIENT / INSUFFICIENT_HISTORY            GATHERING (extend)
    belief NULL DEGENERATE                                     UNRESOLVABLE
    lever never shipped by resolution date                     VOIDED
    prediction with no mapped lever                            UNATTRIBUTED

Units contract (store-both, score-native): the stored magnitude_pct_mean (%) is
the human commitment and stays authoritative for display. At resolution the
scorer derives predicted_native = magnitude_pct_mean/100 x pre_window_mean,
where pre_window_mean is the EXACT pre-period mean the ITS used (the n_pre
points before the intervention date) — both sides of the comparison share one
denominator, so there is no commit-vs-resolution drift. The commit-time
magnitude_native / native_denom_mean snapshot is display/audit only and is
never a scoring input.

Scoring is sign-primary + magnitude-in-CI bonus: direction must match for
CONFIRMED/DIRECTION_CONFIRMED (sign vs the measured edge direction); the in-CI
check only upgrades DIRECTION_CONFIRMED to CONFIRMED, never rescues a wrong
sign.

GATHERING auto-extends resolution_date (a not-yet is not a no) and leaves
resolved_at NULL so the runner re-measures on the next due pass. All other
verdicts are terminal: a re-run is a no-op.

Honesty rules honored here:
  - Elicit-not-assert: this module only ever MEASURES a human-authored
    prediction; nothing in it generates or pre-fills a prospective number.
  - One lever per (decision, metric): the lever lookup resolves "the lever for
    this prediction's metric" (today: the decision's single is_lever action;
    a future decision_actions.lever_metric_id slots into _levers_for without
    touching the verdict machine). Two levers for one (decision, metric) raise
    LeverConflictError loudly BEFORE any write — that raise is the seam where
    multi-lever support would land.

The connection contract mirrors the bridge: `conn` must be an INJECTED,
RLS-scoped psycopg connection (the caller's identity — never the service
role). A cross-scope prediction is simply invisible and untouched.
"""

from __future__ import annotations

import json
from bisect import bisect_left
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

import numpy as np
from psycopg import Connection

from persistence.bridge import _load_metric, persist_metric_readouts

Id = UUID | str

# A GATHERING verdict bumps resolution_date this far forward — matching the
# 14-day descriptive horizon (CLUSTER_POST_WINDOW) as the natural re-check beat.
GATHERING_EXTENSION_DAYS = 14

VERDICTS = (
    "CONFIRMED",
    "DIRECTION_CONFIRMED",
    "REFUTED",
    "INCONCLUSIVE",
    "GATHERING",
    "UNRESOLVABLE",
    "VOIDED",
    "UNATTRIBUTED",
)

TERMINAL_VERDICTS = frozenset(v for v in VERDICTS if v != "GATHERING")


class LeverConflictError(RuntimeError):
    """Two levers found for one (decision, metric) — the v1 invariant is broken.

    Raised loudly BEFORE any write: resolution with two intervention dates is
    ambiguous (which ship date is the intervention? which edge resolves the
    prediction?). This raise is the seam where multi-lever semantics would land.
    """


@dataclass(frozen=True)
class Lever:
    action_id: UUID
    ref: str                      # display: external_ref, else source
    effective_date: date | None   # None = never shipped


@dataclass(frozen=True)
class EdgeState:
    """The materialized belief-table state for the lever edge."""

    direction: str                # POSITIVE | NEGATIVE | INCONCLUSIVE
    belief_score: float | None
    belief_reason: str | None
    lift: float | None            # native units (ITS step coefficient)
    ci_low: float | None
    ci_high: float | None
    edge_id: UUID | None = None


@dataclass(frozen=True)
class ResolutionResult:
    prediction_id: UUID
    status: str                   # RESOLVED | GATHERING | SKIPPED_*
    verdict: str | None
    detail: str


# ---------------------------------------------------------------------------
# Pure verdict machine (unit-testable without a database).
# ---------------------------------------------------------------------------


def pre_verdict(levers: list[Lever], today: date) -> str | None:
    """Verdicts decidable BEFORE measuring: no lever, or a lever that never
    shipped by the resolution date. None means 'proceed to measurement'."""
    if not levers:
        return "UNATTRIBUTED"
    if len(levers) > 1:
        refs = ", ".join(lv.ref for lv in levers)
        raise LeverConflictError(
            f"{len(levers)} levers found for one (decision, metric) — the v1 "
            f"one-lever invariant is broken ({refs}); refusing to resolve"
        )
    eff = levers[0].effective_date
    if eff is None or eff > today:
        return "VOIDED"
    return None


def predicted_native_value(
    magnitude_pct_mean: float, direction: str, pre_window_mean: float | None
) -> float | None:
    """The human commitment converted to native units against the ITS pre-window
    mean. Signed by the predicted direction; |mean| keeps the sign convention
    stable if a metric's pre-mean is ever negative."""
    if pre_window_mean is None or not np.isfinite(pre_window_mean):
        return None
    signed_pct = magnitude_pct_mean if direction == "POSITIVE" else -magnitude_pct_mean
    return signed_pct / 100.0 * abs(float(pre_window_mean))


def verdict_for(
    edge: EdgeState | None, predicted_direction: str, predicted_native: float | None
) -> str:
    """Map the lever edge's belief-table state to a verdict. Sign-primary: the
    in-CI bonus can only upgrade a matched direction to CONFIRMED — it never
    rescues an opposite sign, and a right-direction/wrong-size prediction is
    DIRECTION_CONFIRMED, not REFUTED."""
    if edge is None:
        # Lever shipped but no measurable edge yet (e.g. ship date beyond the
        # observed series) — not yet, which is not a no.
        return "GATHERING"
    if edge.belief_score is None:
        if edge.belief_reason == "DEGENERATE":
            return "UNRESOLVABLE"
        return "GATHERING"  # INSUFFICIENT / INSUFFICIENT_HISTORY
    if edge.belief_score < 1.0:
        return "INCONCLUSIVE"  # 0.0/0.5: FDR, autocorrelation, CI-incl-0, placebo
    if edge.direction != predicted_direction:
        return "REFUTED"
    if (
        predicted_native is not None
        and edge.ci_low is not None
        and edge.ci_high is not None
        and edge.ci_low <= predicted_native <= edge.ci_high
    ):
        return "CONFIRMED"
    return "DIRECTION_CONFIRMED"


def pre_window_mean_for(series_values: np.ndarray, split: int) -> float | None:
    """The EXACT pre-period mean the ITS used: the n_pre (= split) observations
    before the intervention. NaN-tolerant to mirror the bridge's NULL->NaN load."""
    if split <= 0:
        return None
    window = np.asarray(series_values, dtype=np.float64)[:split]
    finite = window[np.isfinite(window)]
    if finite.size == 0:
        return None
    return float(finite.mean())


# ---------------------------------------------------------------------------
# DB lookups (all through the caller's RLS-scoped connection).
# ---------------------------------------------------------------------------


def _levers_for(conn: Connection, decision_id: Id, metric_id: Id) -> list[Lever]:
    """The lever(s) for THIS PREDICTION'S METRIC among the decision's actions.

    v1: every is_lever action levers all of the decision's predictions, so this
    is the decision's lever set. Forward-compat: when decision_actions gains
    lever_metric_id, this WHERE clause gains
        and (da.lever_metric_id is null or da.lever_metric_id = %(metric)s)
    and nothing above this function changes. metric_id is accepted (and unused
    today) precisely so callers already pass the future key.
    """
    del metric_id  # unused in v1 — see docstring
    rows = conn.execute(
        "select a.action_id, coalesce(a.external_ref, a.source), a.effective_date "
        "from public.decision_actions da "
        "join public.actions a on a.action_id = da.action_id "
        "where da.decision_id = %s and da.is_lever "
        "order by a.action_id",
        (decision_id,),
    ).fetchall()
    return [Lever(action_id, ref, eff) for action_id, ref, eff in rows]


def _load_edge_state(
    conn: Connection, scope_id: Id, action_id: Id, metric_id: Id
) -> EdgeState | None:
    """The materialized ACTION->METRIC edge for the lever, plus the latest
    authoritative ITS evidence row (the raw stats the belief was projected from)."""
    edge = conn.execute(
        "select e.edge_id, e.direction, e.belief_score, e.belief_reason "
        "from public.causal_edges e "
        "join public.nodes s on s.node_id = e.source_node_id "
        "join public.nodes t on t.node_id = e.target_node_id "
        "where e.scope_id = %s "
        "and s.type = 'ACTION' and s.semantic_ref = %s "
        "and t.type = 'METRIC' and t.semantic_ref = %s",
        (scope_id, action_id, metric_id),
    ).fetchone()
    if edge is None:
        return None
    edge_id, direction, belief_score, belief_reason = edge
    evidence = conn.execute(
        "select lift, ci_low, ci_high from public.evidence_objects "
        "where edge_id = %s and methodology = 'ITS' "
        "order by created_at desc, evidence_id desc limit 1",
        (edge_id,),
    ).fetchone()
    lift, ci_low, ci_high = evidence if evidence else (None, None, None)
    return EdgeState(
        direction=direction,
        belief_score=None if belief_score is None else float(belief_score),
        belief_reason=belief_reason,
        lift=None if lift is None else float(lift),
        ci_low=None if ci_low is None else float(ci_low),
        ci_high=None if ci_high is None else float(ci_high),
        edge_id=edge_id,
    )


def _reference_class_features(conn: Connection, decision_id: Id, metric_id: Id) -> dict:
    """The reference-class features stored with the tuple: metric name, the
    decision's action labels, and the mechanism category (from
    decisions.rationale meta, when the capture flow recorded one)."""
    metric_row = conn.execute(
        "select name from public.metrics where metric_id = %s", (metric_id,)
    ).fetchone()
    decision_row = conn.execute(
        "select title, rationale from public.decisions where decision_id = %s",
        (decision_id,),
    ).fetchone()
    labels = [
        ref
        for (ref,) in conn.execute(
            "select coalesce(a.external_ref, a.source) "
            "from public.decision_actions da "
            "join public.actions a on a.action_id = da.action_id "
            "where da.decision_id = %s order by 1",
            (decision_id,),
        ).fetchall()
    ]
    title, rationale = decision_row if decision_row else (None, None)
    mechanism = None
    if isinstance(rationale, dict):
        meta = rationale.get("meta")
        if isinstance(meta, dict):
            mechanism = meta.get("mechanism_category")
        mechanism = mechanism or rationale.get("mechanism_category")
    return {
        "metric_name": metric_row[0] if metric_row else None,
        "decision_title": title,
        "action_labels": labels,
        "mechanism_category": mechanism,
    }


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------


def resolve_prediction(
    conn: Connection, prediction_id: Id, today: date, force: bool = False
) -> ResolutionResult:
    """Resolve one prediction: measure the lever edge through the real bridge,
    map the belief-table state to a verdict, and persist the memory tuple.

    Idempotent: an already-terminal prediction is a no-op; GATHERING re-measures.
    `force=True` resolves a not-yet-due prediction (the UI's dev "Resolve now").
    `conn` must be RLS-scoped as the caller — a foreign prediction is invisible.
    """
    pid = UUID(str(prediction_id))
    row = conn.execute(
        "select scope_id, decision_id, metric_id, direction, magnitude_pct_mean, "
        "resolution_date, resolved_verdict "
        "from public.predictions where prediction_id = %s",
        (pid,),
    ).fetchone()
    if row is None:
        return ResolutionResult(
            pid, "SKIPPED_NOT_VISIBLE", None,
            "prediction not visible under this connection's RLS scope",
        )
    (scope_id, decision_id, metric_id, predicted_direction,
     magnitude_pct_mean, resolution_date, resolved_verdict) = row

    if resolved_verdict is not None and resolved_verdict in TERMINAL_VERDICTS:
        return ResolutionResult(
            pid, "SKIPPED_ALREADY_RESOLVED", resolved_verdict,
            "terminal verdict already written; re-run is a no-op",
        )
    if not force and resolution_date > today:
        return ResolutionResult(
            pid, "SKIPPED_NOT_DUE", None,
            f"due {resolution_date.isoformat()}",
        )

    # Lever lookup FIRST: the duplicate-lever raise must precede any write.
    levers = _levers_for(conn, decision_id, metric_id)
    features = _reference_class_features(conn, decision_id, metric_id)

    tuple_base = {
        "predicted_direction": predicted_direction,
        "predicted_magnitude_pct": float(magnitude_pct_mean),
        **features,
        "decision_id": str(decision_id),
        "metric_id": str(metric_id),
    }

    early = pre_verdict(levers, today)
    if early is not None:
        detail = (
            "no lever mapped — nothing to measure" if early == "UNATTRIBUTED"
            else "the lever never shipped by the resolution date"
        )
        _write_terminal(conn, pid, None, early, {**tuple_base, "verdict": early})
        conn.commit()
        return ResolutionResult(pid, "RESOLVED", early, detail)

    lever = levers[0]
    tuple_base["lever_action_id"] = str(lever.action_id)
    tuple_base["lever_ref"] = lever.ref

    # Measure through the real bridge (idempotent upsert; commits internally).
    persist_metric_readouts(conn, scope_id, metric_id)

    edge = _load_edge_state(conn, scope_id, lever.action_id, metric_id)

    # The scoring denominator: the exact pre-window the ITS saw for this lever.
    metric = _load_metric(conn, metric_id)
    denom = None
    if metric is not None and lever.effective_date is not None:
        split = bisect_left(metric.ordinals, lever.effective_date.toordinal())
        denom = pre_window_mean_for(metric.series.values, split)

    predicted_native = predicted_native_value(
        float(magnitude_pct_mean), predicted_direction, denom
    )
    verdict = verdict_for(edge, predicted_direction, predicted_native)

    measured_pct = None
    if edge is not None and edge.lift is not None and denom:
        measured_pct = edge.lift / abs(denom) * 100.0

    memory_tuple = {
        **tuple_base,
        "predicted_native": predicted_native,
        "pre_window_mean": denom,
        "measured_direction": edge.direction if edge else None,
        "measured_lift": edge.lift if edge else None,
        "measured_pct": measured_pct,
        "ci_low": edge.ci_low if edge else None,
        "ci_high": edge.ci_high if edge else None,
        "belief_score": edge.belief_score if edge else None,
        "belief_reason": edge.belief_reason if edge else None,
        "verdict": verdict,
    }
    edge_id = edge.edge_id if edge else None

    if verdict == "GATHERING":
        extended = today + timedelta(days=GATHERING_EXTENSION_DAYS)
        conn.execute(
            "update public.predictions set resolved_verdict = 'GATHERING', "
            "resolution_date = %s, resolved_edge_id = %s, resolution_tuple = %s "
            "where prediction_id = %s",
            (extended, edge_id, json.dumps(memory_tuple), pid),
        )
        conn.commit()
        return ResolutionResult(
            pid, "GATHERING", "GATHERING",
            f"not yet measurable — resolution_date extended to {extended.isoformat()}",
        )

    _write_terminal(conn, pid, edge_id, verdict, memory_tuple)
    conn.commit()
    return ResolutionResult(pid, "RESOLVED", verdict, f"edge {edge_id}")


def _write_terminal(
    conn: Connection, prediction_id: UUID, edge_id: UUID | None,
    verdict: str, memory_tuple: dict,
) -> None:
    resolved_at = datetime.now(timezone.utc)
    conn.execute(
        "update public.predictions set resolved_edge_id = %s, resolved_verdict = %s, "
        "resolved_at = %s, resolution_tuple = %s where prediction_id = %s",
        (
            edge_id,
            verdict,
            resolved_at,
            json.dumps({**memory_tuple, "resolved_at": resolved_at.isoformat()}),
            prediction_id,
        ),
    )


def resolve_due_predictions(
    conn: Connection, scope_id: Id, today: date
) -> list[ResolutionResult]:
    """Resolve every due prediction in the scope: unresolved rows plus GATHERING
    rows whose extended date has arrived (resolved_at stays NULL until terminal)."""
    rows = conn.execute(
        "select prediction_id from public.predictions "
        "where scope_id = %s and resolved_at is null and resolution_date <= %s "
        "order by resolution_date, prediction_id",
        (scope_id, today),
    ).fetchall()
    return [resolve_prediction(conn, pid, today=today) for (pid,) in rows]
