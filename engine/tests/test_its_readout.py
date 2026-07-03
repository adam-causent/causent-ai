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
from hac_oracle import hac_cov

_BASE = 738000  # arbitrary ordinal-day offset; centering absorbs it


def _design(dates, split):
    """Independent mirror of C2's design matrix, for the oracle."""
    t = dates.astype(np.float64)
    post = np.arange(t.size) >= split
    cols = [np.ones(t.size), t - t.mean(), post.astype(np.float64)]
    if split >= 28 and t.size - split >= 28:
        cols.append(np.where(post, t - t[split], 0.0))
    return np.column_stack(cols)


def _make(n_pre, n_post, truth, sigma=0.0, seed=0, rho=0.0):
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    X = _design(dates, n_pre)
    y = X @ np.asarray(truth, float)
    if sigma:
        e = np.random.default_rng(seed).normal(0.0, sigma, n)
        for i in range(1, n):  # AR(1): rho=0 leaves it iid
            e[i] += rho * e[i - 1]
        y = y + e
    return Series(dates=dates, values=y, split=n_pre)


def _oracle_ci(series, alpha=0.05):
    """CI end-to-end from an independent oracle: scipy lstsq + t.ppf, HAC cov."""
    X = _design(series.dates, series.split)
    beta, *_ = sla.lstsq(X, series.values)
    dof = series.values.size - X.shape[1]
    resid = series.values - X @ beta
    cov = hac_cov(X, resid)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    return beta[2], (beta[2] - half, beta[2] + half)


# ---------- golden: recovery of a KNOWN truth ----------

def test_recovers_known_positive_lift():
    r = its_readout(_make(50, 50, [10.0, 0.5, 3.0, 0.25]))  # >= FLOOR_CONFIDENT/side
    assert r.method == "ITS" and r.status == "OK"
    assert r.lift == pytest.approx(3.0, abs=1e-6)
    assert r.ci_low <= 3.0 <= r.ci_high
    assert r.direction == "POSITIVE"
    assert r.n_pre == 50 and r.n_post == 50
    assert r.resid_var == pytest.approx(0.0, abs=1e-9)
    assert math.isfinite(r.cond_number)


def test_recovers_known_negative_lift():
    r = its_readout(_make(50, 50, [4.0, -0.1, -7.5, 0.0]))  # >= FLOOR_CONFIDENT/side
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
    # A strong effect (with adequate history) must be called POSITIVE with the CI
    # excluding 0 nearly always.
    truth = [1.0, 0.05, 5.0, 0.0]
    hits = sum(
        its_readout(_make(50, 50, truth, sigma=2.0, seed=i)).direction == "POSITIVE"
        for i in range(400)
    )
    assert hits / 400 > 0.95


def test_hac_curbs_false_positives_under_autocorrelation():
    # The blocker HAC fixes: under autocorrelated null residuals the iid readout
    # fires spuriously far above alpha; HAC widens its CI and fires much less often.
    truth = [1.0, 0.05, 0.0, 0.0]
    draws = 2000
    hac_fp = iid_fp = 0
    for i in range(draws):
        s = _make(30, 30, truth, sigma=2.0, seed=i, rho=0.8)
        hac_fp += its_readout(s).direction != "INCONCLUSIVE"
        X = _design(s.dates, s.split)
        beta, *_ = sla.lstsq(X, s.values)
        dof = s.values.size - X.shape[1]
        resid = s.values - X @ beta
        se = math.sqrt((resid @ resid / dof) * sla.inv(X.T @ X)[2, 2])
        iid_fp += abs(beta[2]) > stats.t.ppf(0.975, dof) * se
    assert hac_fp < iid_fp - 0.05 * draws   # HAC fires meaningfully less


def test_null_false_positive_white_noise_band():
    # At/above the floor under iid noise the small-sample HAC over-fires modestly vs
    # the 5% ideal — an honest, documented cost of the robustness. (Below the floor
    # the readout withholds entirely; see test_below_floor_is_insufficient_history.)
    truth = [1.0, 0.05, 0.0, 0.0]
    draws = 2000
    fp = 0
    for i in range(draws):
        r = its_readout(_make(45, 45, truth, sigma=2.0, seed=i))  # exactly at the floor
        assert r.status == "OK" and r.lift is not None  # readout still succeeds
        fp += r.direction != "INCONCLUSIVE"
    assert 0.04 <= fp / draws <= 0.13


def test_p_value_matches_scipy_and_gates_significance():
    # p_value is the two-sided step p from the HAC SE: it must match a scipy t
    # oracle and be < 0.05 exactly when the 95% CI excludes 0 (same t critical value).
    for seed in range(30):
        s = _make(50, 50, [1.0, 0.05, 1.5, 0.0], sigma=2.0, seed=seed)
        r = its_readout(s)
        X = _design(s.dates, s.split)
        beta, *_ = sla.lstsq(X, s.values)
        dof = s.values.size - X.shape[1]
        resid = s.values - X @ beta
        se = math.sqrt(hac_cov(X, resid)[2, 2])
        p = 2.0 * stats.t.sf(abs(beta[2] / se), dof)
        assert r.p_value == pytest.approx(p, rel=1e-7, abs=1e-9)
        assert (r.p_value < 0.05) == (r.direction != "INCONCLUSIVE")


# ---------- boundary: the three-way fit / floor / confident gate ----------

def _noisy_series(n_pre, n_post, seed=1):
    """A plainly-fittable series (level + slope + step + noise), any n per side."""
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    rng = np.random.default_rng(seed)
    y = 1.0 + 0.1 * np.arange(n) + rng.normal(0.0, 0.5, n)
    y[n_pre:] += 3.0
    return Series(dates, y, n_pre)


@pytest.mark.parametrize("n_pre,n_post,status", [
    (13, 14, "INSUFFICIENT"),           # pre below MIN_SIDE -> unfittable
    (14, 13, "INSUFFICIENT"),           # post below MIN_SIDE -> unfittable
    (14, 14, "INSUFFICIENT_HISTORY"),   # fittable but below FLOOR_CONFIDENT
    (44, 44, "INSUFFICIENT_HISTORY"),   # one short of the confident floor
    (45, 44, "INSUFFICIENT_HISTORY"),   # post one short of the floor
    (45, 45, "OK"),                     # both exactly at FLOOR_CONFIDENT -> confident
])
def test_side_gate(n_pre, n_post, status):
    r = its_readout(_noisy_series(n_pre, n_post))
    assert r.status == status
    assert r.n_pre == n_pre and r.n_post == n_post


def test_below_floor_is_insufficient_history():
    # Fittable (>= MIN_SIDE/side) but below FLOOR_CONFIDENT: withhold the claim, never
    # fabricate lift/ci/p. This is the "not yet evaluable, gathering data" state.
    r = its_readout(_noisy_series(30, 30, seed=2))
    assert r.status == "INSUFFICIENT_HISTORY"
    assert (r.lift, r.ci_low, r.ci_high, r.p_value) == (None, None, None, None)
    assert r.direction == "INCONCLUSIVE"
    assert r.n_pre == 30 and r.n_post == 30


def test_insufficient_never_fabricates():
    r = its_readout(_make(10, 40, [1.0, 0.1, 3.0]))
    assert r.status == "INSUFFICIENT"
    assert (r.lift, r.ci_low, r.ci_high) == (None, None, None)
    assert (r.resid_var, r.cond_number) == (None, None)
    assert r.p_value is None
    assert r.direction == "INCONCLUSIVE"
    assert r.n_pre == 10 and r.n_post == 40


# ---------- adversarial: degenerate fits -> DEGENERATE, never a number ----------

def _assert_degenerate(r):
    assert r.status == "DEGENERATE"
    assert (r.lift, r.ci_low, r.ci_high) == (None, None, None)
    assert r.p_value is None
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
