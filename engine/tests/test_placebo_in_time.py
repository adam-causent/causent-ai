"""Golden-data + adversarial tests for C6 placebo_in_time.

Truth: on noise-free data the placebo readout recovers a KNOWN pre-period step
(zero when the pre-history is clean, exactly M when a spurious step was planted at
the midpoint). scipy re-derives the placebo readout independently (lstsq + inv +
t.ppf) as the oracle for both the estimate and the fired decision under noise.
scipy is a TEST-ONLY oracle; the shipped engine is numpy-only.
"""

import math

import numpy as np
import pytest
from scipy import linalg as sla
from scipy import stats

from causal.placebo_in_time import placebo_in_time
from causal.types import Series

_BASE = 738000  # arbitrary ordinal-day offset; centering absorbs it


def _design(dates, split):
    """Independent mirror of C2's segmented design matrix, for the oracle."""
    t = dates.astype(np.float64)
    post = np.arange(t.size) >= split
    cols = [np.ones(t.size), t - t.mean(), post.astype(np.float64)]
    if split >= 28 and t.size - split >= 28:
        cols.append(np.where(post, t - t[split], 0.0))
    return np.column_stack(cols)


def _oracle_readout(dates, values, split, alpha=0.05):
    """(step, ci_excludes_zero) end-to-end from scipy for one segmented fit."""
    X = _design(dates, split)
    beta, *_ = sla.lstsq(X, values)
    dof = values.size - X.shape[1]
    resid = values - X @ beta
    cov = (resid @ resid / dof) * sla.inv(X.T @ X)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    step = beta[2]
    return step, (step - half) > 0.0 or (step + half) < 0.0


# ---------- golden: recovery of a KNOWN pre-period truth ----------

def test_clean_pre_period_does_not_fire():
    # Real step lives only after the real split; the pre-history is a clean trend,
    # so the placebo recovers exactly zero and must not fire.
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[n_pre:] += 8.0
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(0.0, abs=1e-6)
    assert r.fired is False


def test_spurious_pre_period_step_fires():
    # A real step planted at the placebo midpoint (index 30) must be recovered
    # exactly and fire (its CI excludes zero).
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[30:] += 6.0
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(6.0, abs=1e-6)
    assert r.fired is True


# ---------- boundary: the 2*window pre-history gate ----------

@pytest.mark.parametrize("split,ok", [
    (54, False),  # midpoint 27, post side 27 < 28 -> cannot place the fake split
    (55, True),   # midpoint 27, post side 28 -> runs
])
def test_pre_history_gate(split, ok):
    n = split + 20  # real n_post = 20 (>=14) so the gate, not C4, decides
    dates = _BASE + np.arange(n)
    vals = 5.0 + 0.3 * np.arange(n)
    vals[split:] += 5.0
    r = placebo_in_time(Series(dates, vals, split=split))
    if ok:
        assert r.status == "OK"
    else:
        assert r.status == "INSUFFICIENT"
        assert r.placebo_lift is None and r.fired is False


def test_tiny_pre_history_is_insufficient():
    r = placebo_in_time(Series(_BASE + np.arange(50), 5.0 + 0.3 * np.arange(50), split=20))
    assert r.status == "INSUFFICIENT"
    assert r.placebo_lift is None and r.fired is False


# ---------- adversarial: unfittable placebo window -> INSUFFICIENT ----------

def test_flat_pre_period_is_insufficient():
    # A real effect exists, but the flat pre-history has no variance to fit ->
    # the placebo is DEGENERATE for C4, reported as INSUFFICIENT ("unverified").
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = np.full(n_pre + n_post, 5.0)
    vals[n_pre:] += 8.0
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    assert r.status == "INSUFFICIENT"
    assert r.placebo_lift is None and r.fired is False


def test_nan_in_pre_period_is_insufficient():
    n_pre, n_post = 60, 30
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[10] = np.nan  # poisons the placebo window, never the whole call
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    assert r.status == "INSUFFICIENT"
    assert r.placebo_lift is None and r.fired is False


# ---------- fired decision is independent of the real readout succeeding ----------

def test_fires_even_when_real_readout_insufficient():
    # Real post side too short -> real readout INSUFFICIENT (real_lift None), but a
    # fittable placebo with a significant spurious step still fires (via its CI).
    n_pre, n_post = 60, 5
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[30:] += 6.0
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(6.0, abs=1e-6)
    assert r.fired is True


def test_clean_placebo_with_insufficient_real_does_not_fire():
    # real_lift is None here; the magnitude clause must be skipped, not crash.
    n_pre, n_post = 60, 5
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    r = placebo_in_time(Series(dates, vals, split=n_pre))
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(0.0, abs=1e-6)
    assert r.fired is False


# ---------- scipy oracle: estimate + fired decision under noise ----------

def test_matches_scipy_oracle_not_fired():
    rng = np.random.default_rng(11)
    n_pre, n_post = 80, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 2.0 + 0.1 * np.arange(n_pre + n_post) + rng.normal(0.0, 1.0, n_pre + n_post)
    vals[n_pre:] += 5.0  # real effect only, clean pre-history
    r = placebo_in_time(Series(dates, vals, split=n_pre))

    p_lift, p_excl = _oracle_readout(dates[:n_pre], vals[:n_pre], n_pre // 2)
    real_lift, _ = _oracle_readout(dates, vals, n_pre)
    expected_fired = bool(abs(p_lift) >= 0.5 * abs(real_lift) or p_excl)

    assert expected_fired is False  # this seed exercises the not-fired path
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(p_lift, rel=1e-9, abs=1e-9)
    assert r.fired is expected_fired


def test_matches_scipy_oracle_fired():
    rng = np.random.default_rng(23)
    n_pre, n_post = 80, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 2.0 + 0.1 * np.arange(n_pre + n_post) + rng.normal(0.0, 1.0, n_pre + n_post)
    vals[n_pre // 2:] += 6.0  # spurious step at the placebo midpoint -> should fire
    r = placebo_in_time(Series(dates, vals, split=n_pre))

    p_lift, p_excl = _oracle_readout(dates[:n_pre], vals[:n_pre], n_pre // 2)
    real_lift, _ = _oracle_readout(dates, vals, n_pre)
    expected_fired = bool(abs(p_lift) >= 0.5 * abs(real_lift) or p_excl)

    assert expected_fired is True  # this seed exercises the fired path
    assert r.status == "OK"
    assert r.placebo_lift == pytest.approx(p_lift, rel=1e-9, abs=1e-9)
    assert r.fired is expected_fired
