"""Seed a realistic Causent demo dataset into local Supabase — then materialize
the decision graph through the REAL engine bridge.

Why this exists
---------------
The v1 UI (app/(dashboard)/*) currently renders from lib/seed.ts (deterministic
demo data). This script stands up the SAME demo semantics inside Postgres so the
UI can be wired to RLS-scoped Supabase reads that carry REAL engine output:
honest ITS causal readouts, not hand-authored impact cells.

It seeds exactly one tenant that mirrors lib/seed.ts:
  org "Causent" -> project "Orbit" -> workspace "Gummy Alpha"
  5 metrics: ARR, Activation Rate, Churn Rate, Gross Profit, Support Tickets
  210 DAILY metric_observations per metric, ending 2025-05-23
  actions as shipped GitHub PRs (#8324..#8421 = the lib/seed.ts May cohort)

The product boundary it demonstrates (docs: FLOOR_CONFIDENT=45)
--------------------------------------------------------------
A confident causal claim (belief 1.0) needs >= 45 daily points on EACH side of a
ship date. The May-2025 cohort ships in the trailing 17 days of the series, so
every one of them has < 45 post-ship points -> the engine withholds belief with
reason INSUFFICIENT_HISTORY ("gathering data"). That is the HONEST reality of
freshly shipped work and is the whole point of the product.

To ALSO exercise the confident path (belief 1.0), two earlier "landmark" PRs ship
in Feb/Mar 2025 with >= 45 points on each side and a clean, strong injected level
step on their primary metric:
  PR #8107 "Billing Retry Logic"   ships 2025-02-03, big +step on ARR
  PR #8256 "Signup Funnel Rebuild" ships 2025-03-05, big +step on Activation Rate
These two are > 14 days apart from each other and from the May cohort, so they
stay LONE actions (no cluster collision) and each earns its own confident edge.

Design choices for a GUARANTEED confident edge:
  - ARR and Activation are built as (flat level + tiny drift + one strong step +
    IID gaussian noise). IID residuals => Durbin-Watson ~ 2 => the belief engine's
    AUTOCORRELATION cap does not fire; the step is ~30+ noise-sigmas => the ITS
    p-value is astronomically small => it survives BH-FDR across the metric family
    => belief 1.0 / POSITIVE. The step is the ONLY structure, so the in-time
    placebo reads ~0 elsewhere and does not fire.
  - The other three metrics (Churn, Gross Profit, Support Tickets) are organic
    mean-reverting series with soft nudges at the May cohort's dates. Their
    readouts land wherever the engine honestly puts them (mostly INCONCLUSIVE /
    INSUFFICIENT_HISTORY) — the demo only needs AT LEAST ONE confident edge.

Idempotent + re-runnable
------------------------
All rows hang off a single deterministic demo org UUID; every domain table
FK-cascades from workspaces -> projects -> orgs on delete, so teardown is just
"delete the demo org (+ the demo auth user)". Each run = full teardown + fresh
seed + fresh bridge materialization, so evidence never accumulates across runs
and the result is byte-stable.

Seeding is done as the postgres superuser (bypassrls). The graph materialization
is run AS THE DEMO USER over an RLS-scoped connection (SET ROLE authenticated +
request.jwt.claims sub=<user>), exactly like production and the E2E gate — so RLS
is actually exercised, not bypassed.

Run:
    cd engine && .venv/bin/python persistence/seed_demo.py
    # honors $DATABASE_URL; defaults to the local stack DSN below.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import date, timedelta

import numpy as np
import psycopg

# Make the engine root importable whether invoked as `python persistence/seed_demo.py`
# (script dir on path) or `python -m persistence.seed_demo` (engine root on path).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from causal.drift import detect_baseline_drift  # noqa: E402
from causal.types import Series  # noqa: E402
from persistence.bridge import persist_metric_readouts  # noqa: E402
from persistence.resolve import resolve_due_predictions  # noqa: E402

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)

# --- Deterministic demo UUIDs (all namespaced under the demo org for exact teardown) --
ORG = uuid.UUID("ca5e0000-0000-0000-0000-0000000000d1")
PROJ = uuid.UUID("ca5e0000-0000-0000-0000-0000000000d2")
SCOPE = uuid.UUID("ca5e0000-0000-0000-0000-0000000000d3")  # workspace = operating level
USER = uuid.UUID("ca5e1111-0000-0000-0000-0000000000d9")   # OWNER of the demo org


def _metric_uuid(slug_n: int) -> uuid.UUID:
    return uuid.UUID(f"ca5e0000-0000-0000-0000-0000000a{slug_n:04d}")


def _action_uuid(pr: int) -> uuid.UUID:
    return uuid.UUID(f"ca5e0000-0000-0000-0000-0000000{pr:05d}")


# --- Time axis: 210 daily points ending 2025-05-23 (mirrors lib/seed.ts) --------------
END_DATE = date(2025, 5, 23)
SERIES_DAYS = 210
DATES = [END_DATE - timedelta(days=SERIES_DAYS - 1 - i) for i in range(SERIES_DAYS)]
START_DATE = DATES[0]  # 2024-10-26


def _idx(d: date) -> int:
    return (d - START_DATE).days


# --- Metric definitions ---------------------------------------------------------------
# id order matches lib/seed.ts. (uuid, name, source, unit)
METRICS = [
    (_metric_uuid(1), "ARR", "csv", "USD"),
    (_metric_uuid(2), "Activation Rate", "csv", "percent"),
    (_metric_uuid(3), "Churn Rate", "csv", "percent"),
    (_metric_uuid(4), "Gross Profit", "csv", "USD"),
    (_metric_uuid(5), "Support Tickets", "csv", "count"),
]
M_ARR, M_ACTIVATION, M_CHURN, M_GP, M_SUPPORT = (m[0] for m in METRICS)

# --- Landmark (confident-capable) ship dates ------------------------------------------
ARR_STEP_DATE = date(2025, 2, 3)        # PR #8107 -> clean +step on ARR
ACTIVATION_STEP_DATE = date(2025, 3, 5)  # PR #8256 -> clean +step on Activation

# --- Baseline-drift beat (C5/#18, the demo's hero signal) -----------------------------
# A SEPARATE metric carries the drift story so it never disturbs the confident-edge
# and verdict stories on the five core metrics (any level shift on their series would
# pollute the dense action->metric graph). Its baseline slides 20% -> 12% mid-window,
# AFTER the prediction was committed and BEFORE any lever shipped — "drift of the
# world" the builder cannot see. The mapped lever is DETECTED-not-shipped, so the
# detector's pre-intervention window is the whole post-commit tail (the prospective
# case), and the prediction never resolves (its date is in the future) so the live
# notice keeps rendering.
DRIFT_METRIC = (_metric_uuid(6), "New-User Activation", "csv", "percent")
M_DRIFT = DRIFT_METRIC[0]
DRIFT_COMMIT_DATE = date(2025, 2, 15)      # when the +3% prediction was committed
DRIFT_SHIFT_DATE = date(2025, 4, 5)        # the baseline slides here (post-commit)
DRIFT_RESOLUTION_DATE = date(2025, 8, 2)   # future vs RESOLVE_TODAY -> stays unresolved
DRIFT_LEVER_PR = 8455                       # the mapped lever — declared, not yet shipped

# --- UNMEASURABLE_NO_METRIC exercise (C5/#18) -----------------------------------------
# A DECLARED metric (source='declared') that never received observations. Its
# pre-registered prediction is due in the past, so the sweep resolves it — and
# the verdict machine returns UNMEASURABLE_NO_METRIC (nothing to measure). The
# scorecard renders the connect/self-report prompt, never a blank or an error.
DECLARED_METRIC = (_metric_uuid(7), "Beta waitlist signups", "declared", "count")
M_DECLARED = DECLARED_METRIC[0]
DECLARED_RESOLUTION_DATE = date(2025, 5, 20)  # past vs RESOLVE_TODAY -> resolves


# --- Series builders ------------------------------------------------------------------
def _clean_step_series(base: float, drift_per_day: float, step: float,
                       step_date: date, noise_sd: float, seed: int) -> list[float]:
    """flat level + tiny linear drift + ONE strong level step + IID gaussian noise.

    IID residuals keep Durbin-Watson ~ 2 (no autocorrelation cap) and the step is
    many noise-sigmas, so the ITS reads an unambiguous, BH-FDR-surviving effect ->
    belief 1.0 on the action at `step_date`."""
    rng = np.random.default_rng(seed)
    si = _idx(step_date)
    out = []
    for i in range(SERIES_DAYS):
        v = base + drift_per_day * i + (step if i >= si else 0.0)
        v += float(rng.normal(0.0, noise_sd))
        out.append(v)
    return out


def _organic_series(base: float, drift_per_day: float, noise_frac: float,
                    nudges: list[tuple[date, float]], seed: int,
                    floor: float = 0.0) -> list[float]:
    """Mean-reverting organic wander with small step nudges at the May cohort's
    dates. Honest-but-noisy: the engine reads these however it reads them."""
    rng = np.random.default_rng(seed)
    nudge_by_idx: dict[int, float] = {}
    for d, delta in nudges:
        nudge_by_idx[_idx(d)] = nudge_by_idx.get(_idx(d), 0.0) + delta
    span = abs(base) or 1.0
    wander = 0.0
    accum = 0.0
    out = []
    for i in range(SERIES_DAYS):
        accum += nudge_by_idx.get(i, 0.0)
        wander += (rng.random() - 0.5) * noise_frac * span * 0.35
        wander *= 0.9  # mean-reverting so it never runs away
        v = base + drift_per_day * i + accum + wander
        v += (rng.random() - 0.5) * noise_frac * span
        out.append(max(floor, v))
    return out


def _build_series() -> dict[uuid.UUID, list[float]]:
    # May cohort ship dates (nudge points for organic metrics).
    may = [date(2025, 5, d) for d in (6, 8, 10, 13, 15, 18, 21, 23)]
    return {
        # CONFIDENT target #1: ARR jumps ~ +$260K on 2025-02-03 (noise sd ~$7K -> ~37 sigma).
        M_ARR: _clean_step_series(
            base=1_920_000.0, drift_per_day=120.0, step=260_000.0,
            step_date=ARR_STEP_DATE, noise_sd=7_000.0, seed=101,
        ),
        # CONFIDENT target #2: Activation jumps +5.5pp on 2025-03-05 (noise sd ~0.35pp).
        M_ACTIVATION: _clean_step_series(
            base=33.5, drift_per_day=0.004, step=5.5,
            step_date=ACTIVATION_STEP_DATE, noise_sd=0.35, seed=202,
        ),
        # Organic supporting metrics (mix of INCONCLUSIVE / INSUFFICIENT_HISTORY).
        M_CHURN: _organic_series(
            base=3.3, drift_per_day=-0.0015, noise_frac=0.04,
            nudges=[(may[3], 0.10), (may[5], -0.06)], seed=303, floor=0.1,
        ),
        M_GP: _organic_series(
            base=980_000.0, drift_per_day=380.0, noise_frac=0.02,
            nudges=[(may[0], 9_000.0), (may[6], 14_000.0)], seed=404,
        ),
        M_SUPPORT: _organic_series(
            base=11_100.0, drift_per_day=-6.0, noise_frac=0.05,
            nudges=[(date(2025, 5, 13), -1_600.0)], seed=505, floor=0.0,
        ),
        # DRIFT beat: flat baseline 20% with ONE clean level slide to 12% at
        # DRIFT_SHIFT_DATE (a -40% baseline move) + tight IID noise -> the
        # change-point detector fires with a clean CI. Its only structure is the
        # slide, so no other window reads as a shift.
        M_DRIFT: _clean_step_series(
            base=20.0, drift_per_day=0.0, step=-8.0,
            step_date=DRIFT_SHIFT_DATE, noise_sd=0.35, seed=606,
        ),
    }


# --- Actions --------------------------------------------------------------------------
# (pr, title, ship_date, primary_metric, hypothesis). The two landmarks ship early
# (>= 45 pts each side -> confident); the #8324..#8421 cohort ships in May (< 45 post
# -> INSUFFICIENT_HISTORY / "gathering data").
ACTIONS = [
    (8107, "Billing Retry Logic", ARR_STEP_DATE, M_ARR,
     "Automatic dunning retries recover involuntary churn and lift ARR."),
    (8256, "Signup Funnel Rebuild", ACTIVATION_STEP_DATE, M_ACTIVATION,
     "A shorter signup funnel raises the share of new users who activate."),
    (8324, "In-App Guidance", date(2025, 5, 6), M_ACTIVATION,
     "Contextual guidance nudges new users to their first success."),
    (8338, "Annual Discount Test", date(2025, 5, 8), M_ARR,
     "An annual-plan discount trades margin for expansion — watch ARR + churn."),
    (8351, "Plan Selector UX", date(2025, 5, 10), M_ARR,
     "A clearer plan selector reduces checkout drop-off."),
    (8367, "Support Deflection v1", date(2025, 5, 13), M_SUPPORT,
     "A help-center deflection widget cuts inbound support tickets."),
    (8383, "Email Nudge Timing", date(2025, 5, 15), M_ACTIVATION,
     "Re-timed onboarding emails re-engage stalled signups."),
    (8392, "Paywall Copy Test", date(2025, 5, 18), M_ARR,
     "Rewritten paywall copy improves paid conversion."),
    (8410, "Onboarding Flow Revamp", date(2025, 5, 21), M_ACTIVATION,
     "A revamped onboarding flow shortens time-to-value."),
    (8421, "Pricing Experiment v2", date(2025, 5, 23), M_ARR,
     "Simplifying the pricing page increases paid conversion."),
    # INCONCLUSIVE probe (epic #6 child #11): ships mid-series on the ORGANIC churn
    # series (no injected step), >= 45 pts each side, and > 14 days from both
    # landmarks AND the May cohort so it never chains into a cluster with them.
    # The honest engine reads no confident effect -> its prediction resolves
    # INCONCLUSIVE ("no confident signal — unproven, not wrong").
    (8290, "Churn Save Offers", date(2025, 4, 1), M_CHURN,
     "A save-offer flow at cancellation intent reduces churn."),
]

# A never-shipped action (effective_date NULL): the bridge skips it (it only loads
# actions with a non-null effective_date), and the prediction mapped to it resolves
# VOIDED ("the lever never shipped").
UNSHIPPED_ACTION = (8440, "Usage-Based Pricing",
                    "Usage-based pricing converts high-usage free teams into revenue.")


# --- Prospective layer (epic #6 child #11): decisions + predictions -------------------
# One graph, two on-ramps: these pre-registered predictions resolve against the SAME
# ITS engine the retrospective path uses. Every target verdict state is exercised:
#   CONFIRMED / REFUTED (ARR class — 2 resolved tuples so priors have a base rate),
#   DIRECTION_CONFIRMED (+ a logged revision), INCONCLUSIVE, GATHERING, VOIDED.
def _decision_uuid(n: int) -> uuid.UUID:
    return uuid.UUID(f"ca5e0000-0000-0000-0000-0000000d{n:04d}")


def _prediction_uuid(n: int) -> uuid.UUID:
    return uuid.UUID(f"ca5e0000-0000-0000-0000-0000000e{n:04d}")


RESOLVE_TODAY = END_DATE  # the demo's "today": resolution runs as of the series end


def _rationale(hypothesis: str, expected_metric: str) -> dict:
    """Minimal TipTap-style rich-text doc for actions.rationale_richtext (jsonb)."""
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph",
             "content": [{"type": "text", "text": hypothesis}]},
        ],
        "meta": {"expected_metric": expected_metric},
    }


# --- Seed / teardown ------------------------------------------------------------------
def _teardown(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        # FK cascade from workspaces->projects->orgs removes every domain row.
        cur.execute("delete from public.orgs where org_id = %s", (ORG,))
        cur.execute("delete from auth.users where id = %s", (USER,))


def _seed(conn: psycopg.Connection, series: dict[uuid.UUID, list[float]]) -> None:
    with conn.cursor() as cur:
        cur.execute("insert into auth.users (id) values (%s)", (USER,))
        cur.execute("insert into public.orgs (org_id, name) values (%s,%s)", (ORG, "Causent"))
        cur.execute(
            "insert into public.projects (project_id, org_id, name) values (%s,%s,%s)",
            (PROJ, ORG, "Orbit"),
        )
        cur.execute(
            "insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,%s)",
            (SCOPE, PROJ, "Gummy Alpha"),
        )
        cur.execute(
            "insert into public.memberships (user_id, org_id, role) values (%s,%s,'owner')",
            (USER, ORG),
        )

        # North-star objective (mirrors lib/seed.ts projectObjective so DB mode
        # and seed mode render the same document).
        cur.execute(
            "insert into public.objectives (scope_id, title, statement, key_results, updated_at) "
            "values (%s,'North Star',%s,%s,%s)",
            (
                SCOPE,
                "Reach $3M ARR by lifting activation and defending against churn — "
                "without eroding gross margin. Every action below is a bet toward that "
                "goal, and Causent reads out which bets actually moved it.",
                json.dumps([
                    "Activation Rate: 33% → 45%",
                    "Net ARR: +$500K from shipped experiments",
                    "Churn Rate: held under 2.5%",
                ]),
                "2025-05-12",
            ),
        )

        for metric_id, name, source, unit in [*METRICS, DRIFT_METRIC]:
            cur.execute(
                "insert into public.metrics (metric_id, scope_id, name, source, granularity, unit) "
                "values (%s,%s,%s,%s,'daily',%s)",
                (metric_id, SCOPE, name, source, unit),
            )
            cur.executemany(
                "insert into public.metric_observations (metric_id, obs_date, value) values (%s,%s,%s)",
                [(metric_id, d, round(float(v), 4)) for d, v in zip(DATES, series[metric_id])],
            )

        # Declared metric (C1/#14): name-only, NO observations — the
        # UNMEASURABLE_NO_METRIC story. Inserted outside the loop above because it
        # has no series to observe.
        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source, granularity, unit) "
            "values (%s,%s,%s,'declared','daily',%s)",
            (M_DECLARED, SCOPE, DECLARED_METRIC[1], DECLARED_METRIC[3]),
        )

        for pr, title, ship, primary_metric, hypothesis in ACTIONS:
            primary_name = next(m[1] for m in METRICS if m[0] == primary_metric)
            cur.execute(
                "insert into public.actions "
                "(action_id, scope_id, source, external_ref, ship_ts, effective_date, "
                " status, rationale_richtext) "
                "values (%s,%s,'github_pr',%s,%s,%s,'merged',%s)",
                (_action_uuid(pr), SCOPE, f"PR #{pr}",
                 f"{ship.isoformat()}T12:00:00+00:00", ship,
                 json.dumps({"title": title, **_rationale(hypothesis, primary_name)})),
            )

        # Never-shipped action: NULL ship_ts/effective_date, status 'open'.
        upr, utitle, uhyp = UNSHIPPED_ACTION
        cur.execute(
            "insert into public.actions "
            "(action_id, scope_id, source, external_ref, ship_ts, effective_date, "
            " status, rationale_richtext) "
            "values (%s,%s,'github_pr',%s,null,null,'open',%s)",
            (_action_uuid(upr), SCOPE, f"PR #{upr}",
             json.dumps({"title": utitle, **_rationale(uhyp, "ARR")})),
        )

        # The drift beat's lever: declared but NOT yet shipped (NULL effective_date),
        # so drift is searched over the whole post-commit window (prospective case).
        cur.execute(
            "insert into public.actions "
            "(action_id, scope_id, source, external_ref, ship_ts, effective_date, "
            " status, rationale_richtext) "
            "values (%s,%s,'github_pr',%s,null,null,'open',%s)",
            (_action_uuid(DRIFT_LEVER_PR), SCOPE, f"PR #{DRIFT_LEVER_PR}",
             json.dumps({"title": "New-User Onboarding Redesign",
                         **_rationale("A rebuilt first-run redesign lifts new-user activation.",
                                      "New-User Activation")})),
        )


def _seed_prospective(conn: psycopg.Connection,
                      series: dict[uuid.UUID, list[float]]) -> None:
    """Decisions + lever mappings + pre-registered predictions (as superuser,
    like the base seed). Resolution then runs AS THE USER via resolve.py.

    Elicit-not-assert: these magnitudes are the seeded HUMANS' committed numbers.
    The two derived from the series (D1 exactly, D3 deliberately ~2x off) are
    computed here only so the demo's verdicts are deterministic."""
    # The scoring denominator resolve.py will derive: the ITS pre-window mean.
    arr_pre_mean = float(np.mean(series[M_ARR][: _idx(ARR_STEP_DATE)]))
    act_pre_mean = float(np.mean(series[M_ACTIVATION][: _idx(ACTIVATION_STEP_DATE)]))
    arr_true_pct = 260_000.0 / arr_pre_mean * 100.0          # ~13.5% -> CONFIRMED
    act_over_pct = round(5.5 / act_pre_mean * 100.0 * 2, 1)  # ~2x actual -> DIRECTION_CONFIRMED

    #      n  title                              lever    metric        dir        pct            resolution_date
    decisions = [
        (1, "Recover involuntary churn revenue", 8107, M_ARR,        "POSITIVE", round(arr_true_pct, 2), date(2025, 5, 15)),
        (2, "Billing retries refund risk",       8107, M_ARR,        "NEGATIVE", 3.0,                    date(2025, 5, 15)),
        (3, "Rebuild the signup funnel",         8256, M_ACTIVATION, "POSITIVE", act_over_pct,           date(2025, 5, 15)),
        (4, "Save offers at cancellation",       8290, M_CHURN,      "NEGATIVE", 5.0,                    date(2025, 5, 20)),
        (5, "Guide new users in-app",            8324, M_ACTIVATION, "POSITIVE", 4.0,                    date(2025, 5, 20)),
        (6, "Move to usage-based pricing",       8440, M_ARR,        "POSITIVE", 6.0,                    date(2025, 5, 20)),
    ]
    with conn.cursor() as cur:
        for n, title, lever_pr, metric_id, direction, pct, due in decisions:
            rationale = {
                "type": "doc",
                "content": [{"type": "paragraph", "content": [
                    {"type": "text", "text": f"We predict: {title}."}]}],
                "meta": {"mechanism_category": "monetization"
                         if metric_id == M_ARR else "activation"
                         if metric_id == M_ACTIVATION else "retention"},
            }
            cur.execute(
                "insert into public.decisions (decision_id, scope_id, title, rationale, created_by) "
                "values (%s,%s,%s,%s,%s)",
                (_decision_uuid(n), SCOPE, title, json.dumps(rationale), USER),
            )
            cur.execute(
                "insert into public.decision_actions (decision_id, action_id) "
                "values (%s,%s)",
                (_decision_uuid(n), _action_uuid(lever_pr)),
            )
            # The lever mark lives in public.levers (C1/#14). PR #8440 never
            # shipped (the VOIDED story): detected but not SHIPPED.
            cur.execute(
                "insert into public.levers (scope_id, decision_id, action_id, "
                "metric_id, provenance_token, target_source, status) "
                "values (%s,%s,%s,%s,%s,'github',%s)",
                (SCOPE, _decision_uuid(n), _action_uuid(lever_pr), metric_id,
                 f"causent-seed-d{n}", "SHIPPED" if lever_pr != 8440 else "DETECTED"),
            )
            cur.execute(
                "insert into public.predictions (prediction_id, scope_id, decision_id, "
                "metric_id, direction, magnitude_pct_mean, resolution_date, committed_by) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s)",
                (_prediction_uuid(n), SCOPE, _decision_uuid(n), metric_id,
                 direction, pct, due, USER),
            )
        # D3 was revised down once — a revision is data, not a failure.
        cur.execute(
            "insert into public.prediction_revisions (prediction_id, old_magnitude, "
            "old_direction, new_magnitude, new_direction, reason, revised_by) "
            "values (%s,%s,'POSITIVE',%s,'POSITIVE',%s,%s)",
            (_prediction_uuid(3), act_over_pct * 1.5, act_over_pct,
             "Pilot cohort data suggested the original estimate was too aggressive.",
             USER),
        )

        # D7 — the DRIFT beat. A +3% New-User Activation prediction committed on
        # DRIFT_COMMIT_DATE, its lever (PR #8455) still unshipped, resolution date
        # in the future so it stays UNRESOLVED (the live notice keeps rendering).
        # Its metric's baseline slid 20% -> 12% after the commit: the detector fires.
        drift_rationale = {
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "We predict: a rebuilt first-run flow lifts "
                 "new-user activation by ~3%."}]}],
            "meta": {"mechanism_category": "activation"},
        }
        cur.execute(
            "insert into public.decisions (decision_id, scope_id, title, rationale, created_by) "
            "values (%s,%s,%s,%s,%s)",
            (_decision_uuid(7), SCOPE, "Lift new-user activation with an onboarding redesign",
             json.dumps(drift_rationale), USER),
        )
        cur.execute(
            "insert into public.decision_actions (decision_id, action_id) values (%s,%s)",
            (_decision_uuid(7), _action_uuid(DRIFT_LEVER_PR)),
        )
        cur.execute(
            "insert into public.levers (scope_id, decision_id, action_id, metric_id, "
            "provenance_token, target_source, status) "
            "values (%s,%s,%s,%s,'causent-seed-d7','github','DETECTED')",
            (SCOPE, _decision_uuid(7), _action_uuid(DRIFT_LEVER_PR), M_DRIFT),
        )
        cur.execute(
            "insert into public.predictions (prediction_id, scope_id, decision_id, "
            "metric_id, direction, magnitude_pct_mean, resolution_date, committed_at, "
            "committed_by) values (%s,%s,%s,%s,'POSITIVE',3.0,%s,%s,%s)",
            (_prediction_uuid(7), SCOPE, _decision_uuid(7), M_DRIFT,
             DRIFT_RESOLUTION_DATE, f"{DRIFT_COMMIT_DATE.isoformat()}T12:00:00+00:00",
             USER),
        )

        # D8 — the UNMEASURABLE_NO_METRIC beat (C5/#18). A prediction committed
        # against the DECLARED metric (no observations), due in the past so the
        # sweep resolves it to UNMEASURABLE_NO_METRIC. No lever needed: the
        # verdict machine short-circuits on the never-wired metric before any ITS.
        declared_rationale = {
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "We predict: a public beta waitlist grows "
                 "signups — a metric we haven't wired to a source yet."}]}],
            "meta": {"mechanism_category": "activation"},
        }
        cur.execute(
            "insert into public.decisions (decision_id, scope_id, title, rationale, created_by) "
            "values (%s,%s,%s,%s,%s)",
            (_decision_uuid(8), SCOPE, "Open a public beta waitlist",
             json.dumps(declared_rationale), USER),
        )
        cur.execute(
            "insert into public.predictions (prediction_id, scope_id, decision_id, "
            "metric_id, direction, magnitude_pct_mean, resolution_date, committed_by) "
            "values (%s,%s,%s,%s,'POSITIVE',20.0,%s,%s)",
            (_prediction_uuid(8), SCOPE, _decision_uuid(8), M_DECLARED,
             DECLARED_RESOLUTION_DATE, USER),
        )


# --- Bridge materialization AS THE DEMO USER (RLS-scoped, never the service role) -----
def _materialize_as_user(scope_id: uuid.UUID, metric_id: uuid.UUID) -> None:
    conn = psycopg.connect(DSN)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(USER), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        persist_metric_readouts(conn, scope_id, metric_id)  # commits internally
    finally:
        conn.close()


# --- Verification ---------------------------------------------------------------------
def _verify(conn: psycopg.Connection) -> dict:
    cur = conn.cursor()

    def scalar(sql, params=()):
        cur.execute(sql, params)
        return cur.fetchone()[0]

    counts = {
        "orgs": scalar("select count(*) from public.orgs where org_id=%s", (ORG,)),
        "projects": scalar("select count(*) from public.projects where org_id=%s", (ORG,)),
        "workspaces": scalar("select count(*) from public.workspaces where project_id=%s", (PROJ,)),
        "memberships": scalar("select count(*) from public.memberships where org_id=%s", (ORG,)),
        "metrics": scalar("select count(*) from public.metrics where scope_id=%s", (SCOPE,)),
        "metric_observations": scalar(
            "select count(*) from public.metric_observations mo "
            "join public.metrics m on m.metric_id=mo.metric_id where m.scope_id=%s", (SCOPE,)),
        "actions": scalar("select count(*) from public.actions where scope_id=%s", (SCOPE,)),
        "clusters": scalar("select count(*) from public.clusters where scope_id=%s", (SCOPE,)),
        "nodes": scalar("select count(*) from public.nodes where scope_id=%s", (SCOPE,)),
        "causal_edges": scalar("select count(*) from public.causal_edges where scope_id=%s", (SCOPE,)),
        "evidence_objects": scalar(
            "select count(*) from public.evidence_objects where scope_id=%s", (SCOPE,)),
    }

    counts["decisions"] = scalar(
        "select count(*) from public.decisions where scope_id=%s", (SCOPE,))
    counts["predictions"] = scalar(
        "select count(*) from public.predictions where scope_id=%s", (SCOPE,))
    counts["prediction_revisions"] = scalar(
        "select count(*) from public.prediction_revisions pr "
        "join public.predictions p on p.prediction_id=pr.prediction_id "
        "where p.scope_id=%s", (SCOPE,))

    confident = scalar(
        "select count(*) from public.causal_edges "
        "where scope_id=%s and belief_score=1.0 and direction='POSITIVE'", (SCOPE,))
    insufficient = scalar(
        "select count(*) from public.causal_edges "
        "where scope_id=%s and belief_reason='INSUFFICIENT_HISTORY'", (SCOPE,))

    # Prospective layer: verdict per seeded prediction (the demo must exercise
    # CONFIRMED / REFUTED / DIRECTION_CONFIRMED / INCONCLUSIVE / GATHERING / VOIDED).
    cur.execute(
        "select d.title, m.name, p.direction, p.magnitude_pct_mean, "
        "p.resolved_verdict, p.resolution_date "
        "from public.predictions p "
        "join public.decisions d on d.decision_id=p.decision_id "
        "join public.metrics m on m.metric_id=p.metric_id "
        "where p.scope_id=%s order by p.prediction_id", (SCOPE,))
    predictions = cur.fetchall()

    # Named breakdown of the ACTION->METRIC edges for a human-readable readout.
    cur.execute(
        "select a.external_ref, m.name, ce.direction, ce.belief_score, ce.belief_reason "
        "from public.causal_edges ce "
        "join public.nodes sn on sn.node_id=ce.source_node_id and sn.type='ACTION' "
        "join public.actions a on a.action_id=sn.semantic_ref "
        "join public.nodes tn on tn.node_id=ce.target_node_id and tn.type='METRIC' "
        "join public.metrics m on m.metric_id=tn.semantic_ref "
        "where ce.scope_id=%s "
        "order by a.effective_date, m.name", (SCOPE,))
    edges = cur.fetchall()

    # DRIFT beat: the seeded baseline slide must actually FIRE the detector, over
    # the prospective window (commit date -> end, no lever shipped). Exercises the
    # real engine on the seeded data, so the seed can't silently stop firing.
    cur.execute(
        "select obs_date, value from public.metric_observations "
        "where metric_id = %s order by obs_date", (M_DRIFT,))
    drift_rows = cur.fetchall()
    drift_series = Series(
        np.array([d.toordinal() for d, _ in drift_rows], dtype=np.int64),
        np.array([float(v) for _, v in drift_rows], dtype=np.float64), 0)
    drift = detect_baseline_drift(
        drift_series, DRIFT_COMMIT_DATE.toordinal(), None)

    return {"counts": counts, "confident_edges": confident,
            "insufficient_edges": insufficient, "edges": edges,
            "predictions": predictions, "drift": drift}


def main() -> int:
    conn = psycopg.connect(DSN)
    conn.autocommit = True
    try:
        _teardown(conn)                 # idempotent: wipe any prior demo tenant
        series = _build_series()
        _seed(conn, series)             # base data as superuser (bypassrls)
        _seed_prospective(conn, series)  # decisions + pre-registered predictions
    finally:
        conn.close()

    for metric_id, name, *_ in METRICS:  # materialize the graph AS THE USER, per metric
        _materialize_as_user(SCOPE, metric_id)

    # Resolve the due predictions AS THE USER through the real verdict machine
    # (RLS-scoped, same contract as production / the "Resolve now" affordance).
    conn = psycopg.connect(DSN)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(USER), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        resolve_due_predictions(conn, SCOPE, today=RESOLVE_TODAY)
    finally:
        conn.close()

    conn = psycopg.connect(DSN)
    conn.autocommit = True
    try:
        result = _verify(conn)
    finally:
        conn.close()

    c = result["counts"]
    print("=== Causent demo seed — row counts (scope: Causent/Orbit/Gummy Alpha) ===")
    for k, v in c.items():
        print(f"  {k:22s} {v}")
    print(f"\n  confident edges (belief=1.0 POSITIVE) : {result['confident_edges']}")
    print(f"  INSUFFICIENT_HISTORY edges            : {result['insufficient_edges']}")

    print("\n=== ACTION -> METRIC edges (real engine readouts) ===")
    print(f"  {'action':9s} {'metric':16s} {'direction':13s} {'belief':7s} reason")
    for ref, metric, direction, belief, reason in result["edges"]:
        bstr = "—" if belief is None else f"{belief:.2f}"
        print(f"  {ref:9s} {metric:16s} {direction:13s} {bstr:7s} {reason or ''}")

    print("\n=== Pre-registered predictions (resolved via the verdict machine) ===")
    print(f"  {'decision':38s} {'metric':16s} {'dir':9s} {'pct':7s} verdict")
    for title, metric, direction, pct, verdict, due in result["predictions"]:
        print(f"  {title:38s} {metric:16s} {direction:9s} {pct:7.2f} "
              f"{verdict or '(unresolved)'}  (due {due})")

    drift = result["drift"]
    print("\n=== Baseline-drift beat (New-User Activation) ===")
    if drift.status == "FIRED":
        print(f"  FIRED — baseline moved {drift.pre_level:.1f}% -> {drift.post_level:.1f}% "
              f"({drift.pct_change:+.0f}%), CI [{drift.ci_low:.2f}, {drift.ci_high:.2f}]")
    else:
        print(f"  {drift.status} — reason {drift.reason}")

    verdicts = {v for *_, v, _ in result["predictions"] if v}
    target = {"CONFIRMED", "REFUTED", "DIRECTION_CONFIRMED",
              "INCONCLUSIVE", "GATHERING", "VOIDED", "UNMEASURABLE_NO_METRIC"}

    ok = (
        c["metrics"] == 7                            # + drift metric + declared (no-obs) metric
        and c["metric_observations"] == 6 * SERIES_DAYS  # declared metric has NO observations
        and c["actions"] == len(ACTIONS) + 2         # + the VOIDED lever + the drift lever
        and result["confident_edges"] >= 1
        and result["insufficient_edges"] >= 1
        and target <= verdicts
        and drift.status == "FIRED"                  # the seed must fire the drift detector
    )
    print("\nRESULT:", "PASS — confident, gathering-data, all 7 target verdicts, "
          "and a firing baseline-drift beat"
          if ok else f"FAIL — required demo invariants not met "
          f"(verdicts seen: {sorted(verdicts)}; drift: {drift.status})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
