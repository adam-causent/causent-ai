"""Matrix + adversarial tests for C5/#18 baseline-drift detector.

The load-bearing property (Eng review, "the correctness crux"): drift is searched
in the PRE-INTERVENTION window only, so a lever's own effect (a step at ship_date)
is NEVER flagged as drift. That case is proven both directions here — with the
ship bound the lever step is invisible; without it the same step would fire.

Truth is injected: known level shifts on otherwise flat/noisy series, then the
detector must (a) fire on a real in-window shift with the right sign+magnitude,
(b) stay silent on flat/noise/below-floor/lever-effect, and (c) say
NO_BASELINE_YET when it cannot honestly evaluate. Mirrors test_segmented_ols.
"""

import numpy as np
import pytest

from causal.drift import DRIFT_MIN_PCT, detect_baseline_drift
from causal.segmented_ols import _MIN_SEG
from causal.types import Series

_BASE = 738000  # arbitrary ordinal-day offset; the detector centers time internally


def _series(n, base, step=0.0, step_at=None, sigma=0.0, seed=0, drift_per_day=0.0):
    """Consecutive daily ordinals from _BASE: flat `base` + optional one level
    `step` at index `step_at` + tiny drift + IID gaussian noise."""
    dates = _BASE + np.arange(n)
    rng = np.random.default_rng(seed)
    values = np.empty(n, dtype=np.float64)
    for i in range(n):
        v = base + drift_per_day * i + (step if (step_at is not None and i >= step_at) else 0.0)
        if sigma:
            v += float(rng.normal(0.0, sigma))
        values[i] = v
    return Series(dates.astype(np.int64), values, 0)


def _ord(i):
    return _BASE + i


# ---------- fires on a real in-window baseline shift ----------

def test_fires_on_seeded_shift():
    # Baseline 20 -> 12 (a -40% move) mid-window, no lever shipped (prospective).
    s = _series(120, base=20.0, step=-8.0, step_at=60, sigma=0.4, seed=1)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "FIRED"
    assert r.reason == "fired"
    assert r.direction == "down"
    assert r.pre_level == pytest.approx(20.0, abs=0.3)
    assert r.post_level == pytest.approx(12.0, abs=0.3)
    assert r.pct_change == pytest.approx(-40.0, abs=3.0)
    assert r.ci_high is not None and r.ci_high < 0.0  # CI excludes 0, on the negative side
    assert r.shift_ordinal == pytest.approx(_ord(60), abs=3)  # change-point recovered
    assert r.n_pre >= _MIN_SEG and r.n_post >= _MIN_SEG


def test_fires_upward_shift_direction():
    s = _series(120, base=10.0, step=+4.0, step_at=55, sigma=0.3, seed=2)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "FIRED"
    assert r.direction == "up"
    assert r.pct_change > 0.0
    assert r.ci_low is not None and r.ci_low > 0.0


# ---------- the correctness crux: a lever effect is never drift ----------

def test_lever_effect_in_window_is_not_flagged_as_drift():
    # The ONLY structure is a +6 step at the lever's ship date (index 80): the
    # lever WORKED. With the pre-intervention window [commit, ship) that step sits
    # outside the window, so the detector must stay silent — it is not drift.
    s = _series(120, base=20.0, step=+6.0, step_at=80, sigma=0.4, seed=3)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=_ord(80))
    assert r.status == "NOT_FIRED", "the lever's own effect must not read as drift"

    # Proof the window is what protects us: hand the SAME series the whole
    # post-commit window (ship=None) and the lever step now fires. The bound —
    # not the data — separates "world moved" from "my lever worked".
    r_whole = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r_whole.status == "FIRED"


def test_real_drift_before_ship_still_fires():
    # A genuine baseline slide at index 40 with the lever shipping later (index 80):
    # the slide is inside [commit, ship) and must fire even though a lever exists.
    s = _series(120, base=20.0, step=-8.0, step_at=40, sigma=0.4, seed=4)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=_ord(80))
    assert r.status == "FIRED"
    assert r.direction == "down"
    assert r.shift_ordinal == pytest.approx(_ord(40), abs=3)


# ---------- silence on flat / noise ----------

def test_flat_window_does_not_fire():
    s = _series(120, base=20.0, sigma=0.0)  # perfectly flat: no signal to explain
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "NOT_FIRED"


def test_pure_noise_does_not_fire():
    # No step, only noise: no candidate change-point's CI excludes 0.
    s = _series(150, base=20.0, sigma=0.8, seed=11)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "NOT_FIRED"
    assert r.reason in ("no_significant_shift", "below_floor")


# ---------- magnitude floor boundary ----------

def test_below_floor_does_not_fire():
    # A credible but tiny shift (-2.5%, under the 5% floor) with low noise so the
    # CI cleanly excludes 0 — significance alone is not enough to interrupt.
    s = _series(160, base=20.0, step=-0.5, step_at=80, sigma=0.05, seed=21)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "NOT_FIRED"
    assert r.reason == "below_floor"
    assert abs(r.pct_change) < DRIFT_MIN_PCT


def test_just_above_floor_fires():
    # A -7.5% move clears the 5% floor.
    s = _series(160, base=20.0, step=-1.5, step_at=80, sigma=0.05, seed=22)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "FIRED"
    assert abs(r.pct_change) >= DRIFT_MIN_PCT


# ---------- NO_BASELINE_YET: cannot honestly evaluate ----------

def test_too_few_points_is_no_baseline_yet():
    # Below 2*_MIN_SEG points, no change-point is fittable — even with a big step.
    s = _series(50, base=20.0, step=-8.0, step_at=25, sigma=0.4, seed=31)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "NO_BASELINE_YET"
    assert r.reason == "gathering_baseline"


def test_no_observations_in_window_is_no_baseline_yet():
    # Commit date past the end of the series: the window is empty.
    s = _series(120, base=20.0, step=-8.0, step_at=60, sigma=0.4, seed=32)
    r = detect_baseline_drift(s, commit_ordinal=_ord(500), ship_ordinal=None)
    assert r.status == "NO_BASELINE_YET"
    assert r.reason == "no_observations"


def test_all_nan_window_is_no_baseline_yet():
    s = _series(120, base=20.0, sigma=0.0)
    vals = s.values.copy()
    vals[:] = np.nan
    r = detect_baseline_drift(Series(s.dates, vals, 0), commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "NO_BASELINE_YET"
    assert r.reason == "no_observations"


def test_ship_before_commit_empty_window():
    s = _series(120, base=20.0, step=-8.0, step_at=60, sigma=0.4, seed=33)
    r = detect_baseline_drift(s, commit_ordinal=_ord(90), ship_ordinal=_ord(10))
    assert r.status == "NO_BASELINE_YET"


# ---------- adversarial: never raises, never NaN status ----------

def test_nan_in_window_never_raises():
    s = _series(120, base=20.0, step=-8.0, step_at=60, sigma=0.4, seed=41)
    vals = s.values.copy()
    vals[5] = np.nan
    vals[70] = np.inf
    r = detect_baseline_drift(Series(s.dates, vals, 0), commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status in ("FIRED", "NOT_FIRED", "NO_BASELINE_YET")


def test_window_exactly_at_floor_boundary():
    # Exactly 2*_MIN_SEG points: the single fittable split (28/28) is allowed.
    n = 2 * _MIN_SEG
    s = _series(n, base=20.0, step=-8.0, step_at=_MIN_SEG, sigma=0.2, seed=51)
    r = detect_baseline_drift(s, commit_ordinal=_ord(0), ship_ordinal=None)
    assert r.status == "FIRED"
    assert r.n_pre == _MIN_SEG and r.n_post == _MIN_SEG
