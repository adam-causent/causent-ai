"""Golden-data + adversarial tests for C3 step_ci.

Truth sources: scipy.stats.t.ppf as the critical-value oracle (combined with an
independently-inverted covariance), and Monte Carlo coverage — over many noise
draws a 95% CI must contain the true step ~95% of the time. scipy is a TEST-ONLY
oracle; the shipped engine is numpy-only (see engine/causal/step_ci.py).
"""

import math

import numpy as np
import pytest
from scipy import linalg as sla
from scipy import stats

from causal.segmented_ols import segmented_ols
from causal.step_ci import step_ci
from causal.types import Fit, Series
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


def _iid_ci(series, alpha=0.05):
    """The naive iid-OLS interval — kept only to show HAC beats it under autocorrelation."""
    X = _design(series.dates, series.split)
    beta, *_ = sla.lstsq(X, series.values)
    dof = series.values.size - X.shape[1]
    resid = series.values - X @ beta
    cov = (resid @ resid / dof) * sla.inv(X.T @ X)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    return beta[2] - half, beta[2] + half


def _oracle_ci(series, alpha=0.05):
    """CI end-to-end from an independent oracle: scipy lstsq + t.ppf, HAC cov."""
    X = _design(series.dates, series.split)
    beta, *_ = sla.lstsq(X, series.values)
    dof = series.values.size - X.shape[1]
    resid = series.values - X @ beta
    cov = hac_cov(X, resid)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    return beta[2] - half, beta[2] + half


# ---------- golden: matches an independent scipy oracle ----------

def test_matches_scipy_oracle():
    s = _make(50, 45, [2.0, 0.3, 5.0, -0.1], sigma=1.5, seed=7)
    lo, hi = step_ci(segmented_ols(s))
    o_lo, o_hi = _oracle_ci(s)
    assert lo == pytest.approx(o_lo, rel=1e-9, abs=1e-9)
    assert hi == pytest.approx(o_hi, rel=1e-9, abs=1e-9)


def test_matches_scipy_oracle_three_coeff():
    # 3-coefficient fit (post side < 28): df must use k=3.
    s = _make(60, 20, [4.0, -0.2, 7.5], sigma=2.0, seed=3)
    fit = segmented_ols(s)
    assert fit.coeffs.shape == (3,)
    lo, hi = step_ci(fit)
    o_lo, o_hi = _oracle_ci(s)
    assert (lo, hi) == pytest.approx((o_lo, o_hi), rel=1e-9, abs=1e-9)


@pytest.mark.parametrize("alpha", [0.10, 0.05, 0.01])
def test_matches_oracle_across_alpha(alpha):
    s = _make(40, 40, [1.0, 0.1, 3.0, 0.2], sigma=1.0, seed=11)
    lo, hi = step_ci(segmented_ols(s), alpha=alpha)
    o_lo, o_hi = _oracle_ci(s, alpha=alpha)
    assert (lo, hi) == pytest.approx((o_lo, o_hi), rel=1e-9, abs=1e-9)


# ---------- golden: recovery of a KNOWN truth via coverage ----------

def test_coverage_white_noise_near_nominal():
    # Under iid residuals the HAC interval is still ~nominal; the small-sample
    # Newey-West downward bias costs a few points of coverage at n=70 — a known,
    # honest cost of buying autocorrelation-robustness. Not the fabricated 0.95.
    truth = [1.0, 0.1, 4.0, 0.0]
    step = truth[2]
    draws = 3000
    covered = 0
    for i in range(draws):
        lo, hi = step_ci(segmented_ols(_make(35, 35, truth, sigma=2.0, seed=i)))
        covered += lo <= step <= hi
    assert 0.86 <= covered / draws <= 0.96


def test_hac_restores_coverage_under_autocorrelation():
    # The whole point of HAC: with positively autocorrelated residuals the naive
    # iid interval understates SEs and badly under-covers; HAC widens and recovers
    # much of the lost coverage. HAC must strictly beat iid by a clear margin.
    truth = [1.0, 0.1, 4.0, 0.0]
    step = truth[2]
    draws = 2000
    hac = iid = 0
    for i in range(draws):
        s = _make(35, 35, truth, sigma=2.0, seed=i, rho=0.8)
        lo, hi = step_ci(segmented_ols(s))
        hac += lo <= step <= hi
        lo2, hi2 = _iid_ci(s)
        iid += lo2 <= step <= hi2
    assert hac > iid + 0.08 * draws   # HAC clearly better under AR(1)
    assert iid / draws < 0.60         # iid catastrophically under-covers


# ---------- structure & monotonicity ----------

def test_symmetric_about_point_estimate():
    fit = segmented_ols(_make(50, 50, [2.0, 0.0, 6.0, 0.0], sigma=1.0, seed=2))
    lo, hi = step_ci(fit)
    step = float(fit.coeffs[2])
    assert lo < step < hi
    assert (step - lo) == pytest.approx(hi - step, rel=1e-12)


def test_smaller_alpha_widens():
    fit = segmented_ols(_make(45, 45, [0.0, 0.0, 3.0, 0.0], sigma=1.5, seed=4))
    w95 = np.subtract(*step_ci(fit, 0.05)[::-1])
    w99 = np.subtract(*step_ci(fit, 0.01)[::-1])
    w90 = np.subtract(*step_ci(fit, 0.10)[::-1])
    assert w90 < w95 < w99


def test_noiseless_fit_collapses_to_point():
    # resid_var == 0 (perfect, non-degenerate fit) => zero-width interval.
    fit = segmented_ols(_make(40, 40, [10.0, 0.5, -3.0, 0.25]))
    assert not fit.degenerate
    lo, hi = step_ci(fit)
    assert lo == pytest.approx(-3.0, abs=1e-9)
    assert hi == pytest.approx(-3.0, abs=1e-9)


# ---------- adversarial: degenerate fits yield (nan, nan), never a raise ----------

def _is_nan_pair(ci):
    return math.isnan(ci[0]) and math.isnan(ci[1])


def test_flat_metric_returns_nan():
    n = 60
    dates = _BASE + np.arange(n)
    fit = segmented_ols(Series(dates, np.full(n, 5.0), split=30))
    assert fit.degenerate
    assert _is_nan_pair(step_ci(fit))


def test_split_at_start_returns_nan():
    fit = segmented_ols(_make(0, 50, [1.0, 0.1, 2.0]))
    assert fit.degenerate
    assert _is_nan_pair(step_ci(fit))


def test_too_few_points_returns_nan():
    # n < k: df <= 0 as well as degenerate; must not raise via t_ppf.
    dates = _BASE + np.arange(2)
    fit = segmented_ols(Series(dates, np.array([1.0, 2.0]), split=1))
    assert _is_nan_pair(step_ci(fit))


def test_nan_input_returns_nan():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0, 10, n)
    y[5] = np.nan
    fit = segmented_ols(Series(dates, y, split=30))
    assert fit.degenerate
    assert _is_nan_pair(step_ci(fit))


def test_nonfinite_variance_returns_nan():
    # Hand-built fit with an inf on the step variance: no interval, no crash.
    fit = Fit(coeffs=np.array([0.0, 0.0, 1.0]),
              cov=np.diag([1.0, 1.0, np.inf]),
              resid_var=float("inf"), cond_number=1.0,
              n_pre=30, n_post=30, degenerate=False)
    assert _is_nan_pair(step_ci(fit))


# ---------- adversarial: invalid alpha is a caller error ----------

@pytest.mark.parametrize("alpha", [0.0, 1.0, -0.1, 1.5, float("nan")])
def test_invalid_alpha_raises(alpha):
    fit = segmented_ols(_make(40, 40, [1.0, 0.0, 2.0, 0.0]))
    with pytest.raises(ValueError):
        step_ci(fit, alpha)
