"""Adversarial tests for C2 segmented_ols — written by a reviewer who did NOT
write the component. Goal: BREAK it.

Two attack surfaces:
  1. Numeric correctness — recover a KNOWN injected step within tolerance and,
     where numeric, hold the engine to scipy.linalg.lstsq as an independent OLS
     oracle (coeffs + covariance). scipy is TEST-ONLY; the engine is numpy.
  2. Degenerate/edge robustness — flat, all-identical, perfectly collinear,
     constant dates, n<3, empty, out-of-range split, non-finite. Contract:
     degenerate=True, never NaN, never raise.
"""

import warnings

import numpy as np
import pytest
from scipy import linalg as sla

from causal.segmented_ols import segmented_ols
from causal.types import Fit, Series
from hac_oracle import hac_cov

_BASE = 738000
_COND_MAX = 1e10
_VAR_FLOOR = 1e-10


# --------------------------------------------------------------------------
# independent oracle-side rebuild of the design matrix
# --------------------------------------------------------------------------

def _design(dates, split):
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


def _clean(fit: Fit):
    """No NaN anywhere the contract promises a defined value."""
    assert isinstance(fit, Fit)
    assert not np.isnan(fit.coeffs).any()
    assert not np.isnan(fit.cov).any()
    assert not np.isnan(fit.resid_var)
    assert isinstance(fit.degenerate, bool)


# --------------------------------------------------------------------------
# 1. KNOWN-STEP RECOVERY (the core claim) — noise-free and noisy
# --------------------------------------------------------------------------

@pytest.mark.parametrize("step", [-50.0, -0.7, 0.0, 3.3, 1000.0])
def test_recovers_injected_step_exactly_noise_free(step):
    truth = [12.0, 0.4, step, -0.15]
    fit = segmented_ols(_make(45, 45, truth))
    assert not fit.degenerate
    assert fit.coeffs[2] == pytest.approx(step, abs=1e-6)
    assert fit.coeffs == pytest.approx(truth, abs=1e-6)


def test_recovers_injected_step_under_noise_within_tolerance():
    # With ~2600 obs the step SE is tiny; the point estimate must land on truth.
    step = 6.25
    fit = segmented_ols(_make(1300, 1300, [3.0, 0.05, step, -0.02], sigma=1.0, seed=11))
    assert not fit.degenerate
    se = float(np.sqrt(fit.cov[2, 2]))
    assert abs(fit.coeffs[2] - step) < 5 * se       # inside 5 sigma
    assert abs(fit.coeffs[2] - step) < 0.5          # and tight in absolute terms


def test_step_is_the_discontinuity_not_the_trend():
    # A pure trend with NO jump must yield step ~ 0 even with strong slopes.
    fit = segmented_ols(_make(60, 60, [5.0, 2.0, 0.0, -3.0]))
    assert not fit.degenerate
    assert fit.coeffs[2] == pytest.approx(0.0, abs=1e-6)


# --------------------------------------------------------------------------
# 2. SCIPY ORACLE — coeffs, covariance, resid_var (randomized battery)
# --------------------------------------------------------------------------

@pytest.mark.parametrize("seed", range(12))
def test_matches_scipy_oracle_randomized(seed):
    rng = np.random.default_rng(seed)
    n_pre = int(rng.integers(28, 80))
    n_post = int(rng.integers(28, 80))
    truth = rng.normal(0, 3, 4)
    s = _make(n_pre, n_post, truth, sigma=float(rng.uniform(0.5, 4.0)), seed=seed + 100)
    fit = segmented_ols(s)
    X = _design(s.dates, s.split)
    beta, *_ = sla.lstsq(X, s.values)
    dof = s.values.size - X.shape[1]
    resid = s.values - X @ beta

    assert not fit.degenerate
    assert fit.coeffs == pytest.approx(beta, rel=1e-7, abs=1e-7)
    assert fit.resid_var == pytest.approx(resid @ resid / dof, rel=1e-8)
    assert fit.cov == pytest.approx(hac_cov(X, resid), rel=1e-6, abs=1e-9)


def test_cond_number_matches_numpy_cond_of_design():
    s = _make(40, 40, [1.0, 0.3, 2.0, -0.1], sigma=1.0, seed=3)
    fit = segmented_ols(s)
    X = _design(s.dates, s.split)
    assert fit.cond_number == pytest.approx(float(np.linalg.cond(X)), rel=1e-6)


def test_step_se_tracks_spread_monte_carlo():
    # Independent MC: under white noise the HAC SE recovers the empirical spread
    # of the step estimate to within its finite-sample band; the estimate is unbiased.
    truth = [0.0, 0.05, 3.0, 0.0]
    sigma, draws = 1.5, 3000
    est = np.empty(draws)
    rep = np.empty(draws)
    for i in range(draws):
        fit = segmented_ols(_make(30, 30, truth, sigma=sigma, seed=5000 + i))
        est[i] = fit.coeffs[2]
        rep[i] = np.sqrt(fit.cov[2, 2])
    assert est.mean() == pytest.approx(truth[2], abs=0.15)   # unbiased
    assert 0.78 <= rep.mean() / est.std() <= 1.02            # tracks the true spread


# --------------------------------------------------------------------------
# 3. DEGENERATE INPUTS — degenerate=True, no NaN, no raise
# --------------------------------------------------------------------------

def test_all_identical_values_degenerate():
    n = 70
    fit = segmented_ols(Series(_BASE + np.arange(n), np.full(n, 42.0), split=35))
    assert fit.degenerate
    _clean(fit)


def test_near_flat_below_var_floor_degenerate():
    n = 70
    # variance engineered just under the floor -> no signal to explain.
    y = np.full(n, 3.0)
    y[0] += np.sqrt(_VAR_FLOOR) * 0.1
    assert y.var() < _VAR_FLOOR
    fit = segmented_ols(Series(_BASE + np.arange(n), y, split=35))
    assert fit.degenerate
    _clean(fit)


def test_split_at_start_collinear_degenerate():
    # split=0 => post is all-ones, collinear with the intercept.
    fit = segmented_ols(_make(0, 60, [1.0, 0.2, 3.0]))
    assert fit.degenerate
    assert fit.cond_number > _COND_MAX
    _clean(fit)


def test_split_at_end_null_column_degenerate():
    # split=n => post is all-zeros (a dead column) -> rank deficient.
    n = 60
    y = np.linspace(0.0, 20.0, n)
    fit = segmented_ols(Series(_BASE + np.arange(n), y, split=n))
    assert fit.degenerate
    _clean(fit)


def test_constant_dates_kills_trend_column_degenerate():
    # All dates identical => t_centered is the zero vector => rank deficient.
    n = 60
    y = np.linspace(0.0, 10.0, n)
    fit = segmented_ols(Series(np.full(n, _BASE), y, split=30))
    assert fit.degenerate
    _clean(fit)


@pytest.mark.parametrize("n", [0, 1, 2])
def test_too_few_points_degenerate(n):
    dates = _BASE + np.arange(n)
    y = np.arange(n, dtype=float)
    split = min(1, n)
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # a raised warning would still be a crash-ish
        try:
            fit = segmented_ols(Series(dates, y, split=split))
        except RuntimeWarning:
            # empty-slice warning on n=0 is tolerable (not an exception at runtime),
            # re-run without the filter to assert the real contract.
            warnings.simplefilter("ignore")
            fit = segmented_ols(Series(dates, y, split=split))
    assert fit.degenerate
    _clean(fit)
    assert fit.coeffs.shape == (3,)


def test_single_point_never_raises():
    fit = segmented_ols(Series(_BASE + np.arange(1), np.array([9.0]), split=0))
    assert fit.degenerate
    _clean(fit)


# --------------------------------------------------------------------------
# 4. NON-FINITE INPUT — degenerate, not a crash, not NaN
# --------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_non_finite_value_degenerate_not_raised(bad):
    n = 60
    y = np.linspace(0.0, 10.0, n)
    y[7] = bad
    fit = segmented_ols(Series(_BASE + np.arange(n), y, split=30))
    assert fit.degenerate
    _clean(fit)


def test_non_finite_date_degenerate_not_raised():
    n = 60
    dates = (_BASE + np.arange(n)).astype(np.float64)
    dates[3] = np.inf
    y = np.linspace(0.0, 10.0, n)
    fit = segmented_ols(Series(dates, y, split=30))
    assert fit.degenerate
    _clean(fit)


# --------------------------------------------------------------------------
# 5. THE >=28-PER-SIDE GATE — off-by-one boundary
# --------------------------------------------------------------------------

@pytest.mark.parametrize("n_pre,n_post,k", [
    (28, 28, 4),
    (28, 29, 4),
    (27, 40, 3),
    (40, 27, 3),
    (27, 27, 3),
])
def test_post_slope_gate_exact_boundary(n_pre, n_post, k):
    truth = [1.0, 0.1, 2.0] + ([0.3] if k == 4 else [])
    fit = segmented_ols(_make(n_pre, n_post, truth))
    assert fit.coeffs.shape == (k,)
    assert fit.n_pre == n_pre and fit.n_post == n_post
    assert not fit.degenerate
    assert fit.coeffs == pytest.approx(truth, abs=1e-6)


# --------------------------------------------------------------------------
# 6. FUZZ — no config should ever raise or emit NaN; non-degenerate == oracle
# --------------------------------------------------------------------------

def test_fuzz_never_raises_never_nan_matches_oracle():
    rng = np.random.default_rng(20260702)
    for _ in range(1500):
        n = int(rng.integers(3, 120))
        split = int(rng.integers(0, n + 1))
        kind = int(rng.integers(0, 5))
        if kind == 0:
            y = rng.normal(0, rng.uniform(0.1, 50), n)
        elif kind == 1:
            y = np.full(n, rng.normal())
        elif kind == 2:
            y = np.linspace(0.0, rng.uniform(-100, 100), n)
        elif kind == 3:
            y = rng.normal(0, 1e-7, n)
        else:
            y = rng.normal(1e6, rng.uniform(1e-3, 10), n)
        dates = _BASE + np.sort(rng.choice(np.arange(n * 3), n, replace=False))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit = segmented_ols(Series(dates, y.astype(float), split))
        _clean(fit)
        if not fit.degenerate:
            X = _design(dates, split)
            beta, *_ = sla.lstsq(X, y.astype(float))
            assert fit.coeffs == pytest.approx(beta, rel=1e-6, abs=1e-6)
