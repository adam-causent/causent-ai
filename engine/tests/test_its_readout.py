"""Golden-data + adversarial tests for C4 its_readout.

Truth: known step coefficients recovered from noise-free data (the golden case),
scipy as an independent CI oracle (lstsq + inv + t.ppf), and Monte-Carlo checks
of the statistical claims the readout makes — the detection rate on a real effect
and the false-positive rate under the null. scipy is a TEST-ONLY oracle; the
shipped engine is numpy-only (see engine/causal/its_readout.py).
"""

import math

import numpy as np
import pytest
from scipy import linalg as sla
from scipy import stats

from causal.its_readout import its_readout
from causal.types import Series

_BASE = 738000  # arbitrary ordinal-day offset; centering absorbs it


def _design(dates, split):
    """Independent mirror of C2's design matrix, for the oracle."""
    t = dates.astype(np.float64)
    post = np.arange(t.size) >= split
    cols = [np.ones(t.size), t - t.mean(), post.astype(np.float64)]
    if split >= 28 and t.size - split >= 28:
        cols.append(np.where(post, t - t[split], 0.0))
    return np.column_stack(cols)


def _make(n_pre, n_post, truth, sigma=0.0, seed=0):
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    X = _design(dates, n_pre)
    y = X @ np.asarray(truth, float)
    if sigma:
        y = y + np.random.default_rng(seed).normal(0.0, sigma, n)
    return Series(dates=dates, values=y, split=n_pre)


def _oracle_ci(series, alpha=0.05):
    """CI computed end-to-end from scipy: independent lstsq + inv + t.ppf."""
    X = _design(series.dates, series.split)
    beta, *_ = sla.lstsq(X, series.values)
    dof = series.values.size - X.shape[1]
    resid = series.values - X @ beta
    cov = (resid @ resid / dof) * sla.inv(X.T @ X)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    return beta[2], (beta[2] - half, beta[2] + half)


# ---------- golden: recovery of a KNOWN truth ----------

def test_recovers_known_positive_lift():
    r = its_readout(_make(40, 40, [10.0, 0.5, 3.0, 0.25]))
    assert r.method == "ITS" and r.status == "OK"
    assert r.lift == pytest.approx(3.0, abs=1e-6)
    assert r.ci_low <= 3.0 <= r.ci_high
    assert r.direction == "POSITIVE"
    assert r.n_pre == 40 and r.n_post == 40
    assert r.resid_var == pytest.approx(0.0, abs=1e-9)
    assert math.isfinite(r.cond_number)


def test_recovers_known_negative_lift():
    r = its_readout(_make(30, 20, [4.0, -0.1, -7.5]))  # post < 28 -> 3-coeff fit
    assert r.status == "OK"
    assert r.lift == pytest.approx(-7.5, abs=1e-6)
    assert r.direction == "NEGATIVE"


def test_ci_matches_scipy_oracle():
    s = _make(50, 45, [2.0, 0.3, 5.0, -0.1], sigma=1.5, seed=7)
    r = its_readout(s)
    o_lift, (o_lo, o_hi) = _oracle_ci(s)
    assert r.lift == pytest.approx(o_lift, rel=1e-9, abs=1e-9)
    assert r.ci_low == pytest.approx(o_lo, rel=1e-9, abs=1e-9)
    assert r.ci_high == pytest.approx(o_hi, rel=1e-9, abs=1e-9)
    assert r.direction == "POSITIVE"  # CI well clear of 0


def test_direction_from_oracle_sign():
    # A modest true effect that the oracle confirms is significant & negative.
    s = _make(60, 55, [1.0, 0.0, -4.0, 0.0], sigma=1.0, seed=13)
    r = its_readout(s)
    _, (o_lo, o_hi) = _oracle_ci(s)
    assert o_hi < 0.0  # oracle says CI excludes 0 on the negative side
    assert r.direction == "NEGATIVE"


# ---------- golden (statistical): detection & false-positive rates ----------

def test_detects_true_effect():
    # A strong effect must be called POSITIVE with the CI excluding 0 nearly always.
    truth = [1.0, 0.05, 5.0, 0.0]
    hits = sum(
        its_readout(_make(30, 30, truth, sigma=2.0, seed=i)).direction == "POSITIVE"
        for i in range(400)
    )
    assert hits / 400 > 0.95


def test_null_false_positive_rate_is_nominal():
    # Under a true zero step, a 95% CI wrongly excludes 0 ~5% of the time.
    truth = [1.0, 0.05, 0.0, 0.0]
    draws = 2000
    fp = 0
    for i in range(draws):
        r = its_readout(_make(30, 30, truth, sigma=2.0, seed=i))
        assert r.status == "OK" and r.lift is not None  # readout still succeeds
        fp += r.direction != "INCONCLUSIVE"
    assert fp / draws == pytest.approx(0.05, abs=0.02)


# ---------- boundary: the 14-per-side gate ----------

@pytest.mark.parametrize("n_pre,n_post,status", [
    (14, 14, "OK"),           # both exactly at the floor -> readout runs
    (13, 14, "INSUFFICIENT"),  # pre one short
    (14, 13, "INSUFFICIENT"),  # post one short
    (13, 13, "INSUFFICIENT"),
])
def test_side_gate(n_pre, n_post, status):
    r = its_readout(_make(n_pre, n_post, [1.0, 0.1, 3.0], sigma=0.5, seed=1))
    assert r.status == status
    assert r.n_pre == n_pre and r.n_post == n_post


def test_insufficient_never_fabricates():
    r = its_readout(_make(10, 40, [1.0, 0.1, 3.0]))
    assert r.status == "INSUFFICIENT"
    assert (r.lift, r.ci_low, r.ci_high) == (None, None, None)
    assert (r.resid_var, r.cond_number) == (None, None)
    assert r.direction == "INCONCLUSIVE"
    assert r.n_pre == 10 and r.n_post == 40


# ---------- adversarial: degenerate fits -> DEGENERATE, never a number ----------

def _assert_degenerate(r):
    assert r.status == "DEGENERATE"
    assert (r.lift, r.ci_low, r.ci_high) == (None, None, None)
    assert r.direction == "INCONCLUSIVE"
    # diagnostics are either absent or finite — never inf/nan leaks into a result.
    for stat in (r.resid_var, r.cond_number):
        assert stat is None or math.isfinite(stat)


def test_flat_metric_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    _assert_degenerate(its_readout(Series(dates, np.full(n, 5.0), split=30)))


def test_subfloor_variance_is_degenerate():
    # Not constant, but variance below the signal floor -> no effect to explain.
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(5.0, 5.0 + 1e-7, n)  # var ~ 8e-16 < _VAR_FLOOR
    _assert_degenerate(its_readout(Series(dates, y, split=30)))


def test_nan_input_is_degenerate_not_raised():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0, 10, n)
    y[5] = np.nan
    _assert_degenerate(its_readout(Series(dates, y, split=30)))


def test_inf_input_is_degenerate_not_raised():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0, 10, n)
    y[10] = np.inf
    _assert_degenerate(its_readout(Series(dates, y, split=30)))
