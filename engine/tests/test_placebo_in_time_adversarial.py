"""Adversarial attack suite for C6 placebo_in_time.

Written by a reviewer who did NOT write the component. Goal: BREAK it.

Strategy:
  * Independent scipy oracle (lstsq + inv + t.ppf) re-derives BOTH the placebo
    estimate and the fired decision; the shipped engine is numpy-only, so scipy
    is a genuine second implementation, not a mirror of the code under test.
  * Degenerate / boundary / hostile inputs must return a well-formed
    PlaceboResult (never raise, never NaN-lift-with-OK), matching the contract:
      - short pre-history  -> INSUFFICIENT (placebo_lift=None, fired=False)
      - a real strong effect must NOT fire
      - a spurious pre-period break SHOULD fire
  * Randomized property test asserts engine == oracle for lift (1e-9) and fired.

scipy is TEST-ONLY; production stays numpy-only.
"""

import math

import numpy as np
import pytest
from scipy import linalg as sla
from scipy import stats

from causal.placebo_in_time import placebo_in_time
from causal.types import FLOOR_CONFIDENT, PLACEBO_ALPHA, PlaceboResult, Series
from hac_oracle import hac_cov

_BASE = 738000
_WINDOW = 14


# --------------------------------------------------------------------------
# Independent scipy oracle
# --------------------------------------------------------------------------

def _design(dates, split):
    t = dates.astype(np.float64)
    post = np.arange(t.size) >= split
    cols = [np.ones(t.size), t - t.mean(), post.astype(np.float64)]
    if split >= 28 and t.size - split >= 28:
        cols.append(np.where(post, t - t[split], 0.0))
    return np.column_stack(cols)


def _oracle_readout(dates, values, split, alpha=0.05):
    """(step, ci_excludes_zero) for one segmented fit, end-to-end from scipy."""
    X = _design(dates, split)
    beta, *_ = sla.lstsq(X, values)
    dof = values.size - X.shape[1]
    resid = values - X @ beta
    cov = hac_cov(X, resid)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    step = beta[2]
    # Same scale-relative dead-zone the engine uses (its_readout.direction_tol),
    # inlined to keep the oracle an independent scipy re-derivation. A zero-residual
    # fit collapses the CI to a point at ~1e-14 dust; without the dead-zone the
    # `> 0.0` boundary flips on the dust's sign and engine/oracle disagree per platform.
    scale = float(np.max(np.abs(values))) if values.size else 0.0
    tol = 1e-9 * (1.0 + scale)
    return step, (step - half) > tol or (step + half) < -tol


def _oracle_placebo(dates, values, split):
    """Full C6 re-derivation for NON-degenerate inputs (adjacent-window placebo).

    The fake split sits at split - MIN_SIDE (post-window = the 14 days before the real
    split); the veto fires at PLACEBO_ALPHA. The magnitude clause compares to the REAL
    readout only when it is OK (both real sides >= FLOOR_CONFIDENT), mirroring the floor.
    """
    if split < 2 * _WINDOW:
        return ("INSUFFICIENT", None, False)
    placebo_split = split - _WINDOW
    p_lift, p_excl = _oracle_readout(dates[:split], values[:split], placebo_split,
                                     alpha=PLACEBO_ALPHA)
    n_post = values.size - split
    real_ok = split >= FLOOR_CONFIDENT and n_post >= FLOOR_CONFIDENT
    if real_ok:
        real_lift, real_excl = _oracle_readout(dates, values, split)  # real readout at 0.05
        mag = real_excl and abs(p_lift) >= 0.5 * abs(real_lift)       # only if real is significant
    else:
        mag = False
    return ("OK", p_lift, bool(mag or p_excl))


def _well_formed(r: PlaceboResult):
    """Every return must satisfy the PlaceboResult invariants."""
    assert isinstance(r, PlaceboResult)
    assert r.status in ("OK", "INSUFFICIENT", "DEGENERATE", "CONFOUNDED")
    assert isinstance(r.fired, bool)
    if r.status == "OK":
        assert r.placebo_lift is not None
        assert math.isfinite(r.placebo_lift)  # never a NaN lift on OK
    else:
        assert r.placebo_lift is None
        assert r.fired is False


# --------------------------------------------------------------------------
# Contract requirement 1: short pre-history -> INSUFFICIENT, never crash
# --------------------------------------------------------------------------

@pytest.mark.parametrize("split", [0, 1, 13, 14, 20, 27])
def test_short_pre_history_is_insufficient(split):
    # For split < 2*window = 28 a 14-pre + 14-post placebo can't fit -> INSUFFICIENT.
    n = split + 30
    dates = _BASE + np.arange(n)
    vals = 5.0 + 0.3 * np.arange(n) + np.sin(np.arange(n))
    r = placebo_in_time(Series(dates, vals, split=split))
    _well_formed(r)
    assert r.status == "INSUFFICIENT"
    assert r.placebo_lift is None and r.fired is False


def test_gate_boundary_27_28():
    # 27 -> only 13 pre + 14 post available (reject); 28 -> 14 + 14 (accept). Exact edge.
    for split, expect_ok in ((27, False), (28, True)):
        n = split + 20
        dates = _BASE + np.arange(n)
        vals = 5.0 + 0.3 * np.arange(n) + np.cos(np.arange(n))
        r = placebo_in_time(Series(dates, vals, split=split))
        _well_formed(r)
        assert (r.status == "OK") is expect_ok


# --------------------------------------------------------------------------
# Contract requirement 2: a real strong effect must NOT fire
# --------------------------------------------------------------------------

@pytest.mark.parametrize("effect", [5.0, 20.0, -12.0, 100.0])
def test_strong_real_effect_does_not_fire(effect):
    # Clean linear pre-history, a big step only AFTER the real split. The placebo
    # lives entirely in the pre-history and must recover ~0 -> not fired.
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[n_pre:] += effect
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    _well_formed(r)
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(0.0, abs=1e-6)
    assert r.fired is False


def test_strong_effect_never_leaks_into_placebo():
    # An absurd post-split effect must not contaminate the placebo window
    # (which is strictly values[:split]): the recovered placebo step stays ~0.
    # (The fired flag on this noise-free series is decided by the CI-collapse of
    # a zero-residual fit; we only assert it agrees with the scipy oracle.)
    n_pre, n_post = 70, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 1.0 + 0.2 * np.arange(n_pre + n_post)
    vals[n_pre:] += 1e6
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    ost, olift, ofired = _oracle_placebo(dates, vals, n_pre)
    _well_formed(r)
    assert r.status == "OK"
    assert abs(r.placebo_lift) < 1e-3   # no leakage of the 1e6 step into pre-history
    assert r.fired is ofired


# --------------------------------------------------------------------------
# Contract requirement 3: a spurious pre-period break SHOULD fire
# --------------------------------------------------------------------------

@pytest.mark.parametrize("step", [4.0, -7.0, 15.0])
def test_spurious_pre_period_break_fires(step):
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[n_pre - _WINDOW:] += step  # break planted exactly at the placebo split
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    _well_formed(r)
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(step, abs=1e-6)
    assert r.fired is True


def test_curved_pre_history_matches_oracle():
    # A nonlinear (accelerating) pre-trend is not captured by a single slope;
    # the segmented placebo fit picks up a spurious step (here ~0.4). Whatever
    # the engine decides for lift AND fired, it must equal the scipy oracle.
    n_pre, n_post = 80, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 2.0 + 0.01 * np.arange(n_pre + n_post) ** 2
    vals[n_pre:] += 3.0
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    ost, olift, ofired = _oracle_placebo(dates, vals, n_pre)
    _well_formed(r)
    assert r.status == ost == "OK"
    assert r.placebo_lift == pytest.approx(olift, rel=1e-9, abs=1e-9)
    assert r.fired is ofired


# --------------------------------------------------------------------------
# Degenerate / hostile inputs: no crash, well-formed, INSUFFICIENT where unfit
# --------------------------------------------------------------------------

def test_empty_series_no_crash():
    r = placebo_in_time(Series(_BASE + np.arange(0), np.array([]), 0))
    _well_formed(r)
    assert r.status == "INSUFFICIENT"


@pytest.mark.parametrize("split", [-1, -100])
def test_negative_split_no_crash(split):
    dates = _BASE + np.arange(60)
    vals = 5.0 + 0.3 * np.arange(60)
    r = placebo_in_time(Series(dates, vals, split=split))
    _well_formed(r)
    assert r.status == "INSUFFICIENT"


def test_split_beyond_length_no_crash():
    dates = _BASE + np.arange(60)
    vals = 5.0 + 0.3 * np.arange(60)
    r = placebo_in_time(Series(dates, vals, split=1000))
    _well_formed(r)
    assert r.status == "INSUFFICIENT"


def test_split_equals_length_no_real_post():
    # Placebo can still be fit on the pre-history even with zero real post data;
    # real_lift is None so the magnitude clause must be skipped, not crash.
    n = 60
    dates = _BASE + np.arange(n)
    vals = 5.0 + 0.3 * np.arange(n)
    r = placebo_in_time(Series(dates, vals, split=n))
    _well_formed(r)
    assert r.status == "OK"
    assert r.fired is False


def test_all_nan_is_insufficient():
    dates = _BASE + np.arange(90)
    r = placebo_in_time(Series(dates, np.full(90, np.nan), split=60))
    _well_formed(r)
    assert r.status == "INSUFFICIENT"


def test_nan_only_in_real_post_still_fits_placebo():
    # Poison lives after the split -> placebo pre-window is clean and fits;
    # real readout degrades to None. Must not crash and must not fire on a clean
    # linear pre-history's recovered ~0 step via the CI clause.
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[70] = np.inf
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    _well_formed(r)
    assert r.status == "OK"
    assert r.fired is False  # CI of a clean linear placebo includes 0


def test_nan_in_placebo_window_is_insufficient():
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[10] = np.nan  # inside the placebo pre-window
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    _well_formed(r)
    assert r.status == "INSUFFICIENT"


def test_flat_pre_history_below_variance_floor_is_insufficient():
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = np.full(n_pre + n_post, 5.0)
    vals[n_pre:] += 8.0  # a real effect exists, but the placebo window is flat
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    _well_formed(r)
    assert r.status == "INSUFFICIENT"


@pytest.mark.parametrize("scale", [1e6, 1e9, 1e12])
def test_huge_values_no_crash(scale):
    n_pre, n_post = 80, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = (5.0 + 0.3 * np.arange(n_pre + n_post)) * scale
    vals[n_pre:] += 4.0 * scale
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    _well_formed(r)


# --------------------------------------------------------------------------
# Oracle characterization: engine == scipy for lift AND fired, many scenarios
# --------------------------------------------------------------------------

@pytest.mark.parametrize("seed", range(60))
def test_engine_matches_scipy_oracle_randomized(seed):
    rng = np.random.default_rng(seed)
    n_pre = int(rng.integers(55, 130))
    n_post = int(rng.integers(14, 60))
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    vals = rng.normal(0.0, 1.0, n) + 0.05 * np.arange(n)

    scenario = seed % 5
    if scenario == 1:
        vals[n_pre:] += rng.uniform(3.0, 10.0)      # strong real effect
    elif scenario == 2:
        vals[n_pre // 2:] += rng.uniform(3.0, 10.0)  # spurious pre-break
    elif scenario == 3:
        vals += 0.002 * np.arange(n) ** 2            # curved pre-trend
    elif scenario == 4:
        vals[n_pre:] -= rng.uniform(3.0, 10.0)       # negative real effect

    r = placebo_in_time(Series(dates, vals, split=n_pre))
    ost, olift, ofired = _oracle_placebo(dates, vals, n_pre)
    _well_formed(r)
    assert r.status == ost
    if ost == "OK":
        assert r.placebo_lift == pytest.approx(olift, rel=1e-9, abs=1e-9)
        assert r.fired is ofired


def test_null_effect_magnitude_clause_matches_oracle():
    # A genuinely NULL, un-confounded series with n_post below FLOOR_CONFIDENT: the real
    # readout is not OK, so the `|placebo_lift| >= 0.5*|real_lift|` clause is skipped
    # entirely and the veto reduces to the conservative PLACEBO_ALPHA CI test. The only
    # correctness claim is engine == oracle.
    rng = np.random.default_rng(7)
    n_pre, n_post = 80, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 2.0 + 0.1 * np.arange(n_pre + n_post) + rng.normal(0.0, 1.0, n_pre + n_post)
    # no step anywhere: true effect is exactly zero, no pre-period confound
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    ost, olift, ofired = _oracle_placebo(dates, vals, n_pre)
    _well_formed(r)
    assert r.status == ost == "OK"
    assert r.placebo_lift == pytest.approx(olift, rel=1e-9, abs=1e-9)
    assert r.fired is ofired
