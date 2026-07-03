"""Golden-data + adversarial tests for C2 segmented_ols.

Truth: known coefficients recovered from noise-free data (the golden case), and
scipy.linalg as an independent OLS oracle for coeffs + covariance. Statistical
validity is checked by Monte Carlo — the reported cov must match the empirical
spread of the step estimate. scipy is a TEST-ONLY oracle; the engine is numpy.
"""

import numpy as np
import pytest
from scipy import linalg as sla

from causal.segmented_ols import segmented_ols
from causal.types import Series
from hac_oracle import hac_cov, hac_lag

_BASE = 738000  # arbitrary ordinal-day offset; centering must absorb it


def _design(dates, split):
    """Mirror of the spec's design matrix, built independently for the oracle."""
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


# ---------- golden: recovery of a known truth ----------

def test_recovers_four_segment_truth():
    truth = [10.0, 0.5, -3.0, 0.25]  # level, pre_slope, step, post_slope
    fit = segmented_ols(_make(40, 40, truth))
    assert fit.coeffs.shape == (4,)
    assert fit.coeffs == pytest.approx(truth, abs=1e-6)
    assert not fit.degenerate
    assert fit.n_pre == 40 and fit.n_post == 40
    assert fit.resid_var == pytest.approx(0.0, abs=1e-12)


def test_recovers_three_segment_truth():
    truth = [4.0, -0.2, 7.5]  # no post_slope column when a side < 28
    fit = segmented_ols(_make(40, 10, truth))
    assert fit.coeffs.shape == (3,)
    assert fit.coeffs == pytest.approx(truth, abs=1e-6)
    assert not fit.degenerate


def test_matches_scipy_oracle():
    truth = [2.0, 0.3, 5.0, -0.1]
    s = _make(50, 45, truth, sigma=1.5, seed=7)
    fit = segmented_ols(s)
    X = _design(s.dates, s.split)
    beta, *_ = sla.lstsq(X, s.values)
    assert fit.coeffs == pytest.approx(beta, rel=1e-8, abs=1e-8)
    # covariance: Newey-West HAC sandwich, independently reconstructed.
    dof = s.values.size - X.shape[1]
    resid = s.values - X @ beta
    assert fit.cov == pytest.approx(hac_cov(X, resid), rel=1e-7, abs=1e-9)
    assert fit.resid_var == pytest.approx(resid @ resid / dof, rel=1e-9)


def test_step_se_tracks_spread_and_widens_under_autocorrelation():
    # White noise: the reported HAC SE recovers the empirical spread of the step
    # estimate to within the finite-sample Newey-West band; the estimate is unbiased.
    truth = [1.0, 0.1, 4.0, 0.0]
    sigma, draws = 2.0, 4000
    est = np.empty(draws)
    reported = np.empty(draws)
    for i in range(draws):
        fit = segmented_ols(_make(35, 35, truth, sigma=sigma, seed=i))
        est[i] = fit.coeffs[2]
        reported[i] = np.sqrt(fit.cov[2, 2])
    assert est.mean() == pytest.approx(truth[2], abs=0.1)   # unbiased
    assert 0.78 <= reported.mean() / est.std() <= 1.02      # tracks the true spread

    # Autocorrelation: the true spread balloons; the HAC SE follows it and is
    # substantially wider than the iid SE, which ignores the serial correlation.
    hac_se = np.empty(draws)
    iid_se = np.empty(draws)
    for i in range(draws):
        s = _make(35, 35, truth, sigma=sigma, seed=i, rho=0.8)
        fit = segmented_ols(s)
        X = _design(s.dates, s.split)
        resid = s.values - X @ fit.coeffs
        dof = s.values.size - X.shape[1]
        hac_se[i] = np.sqrt(fit.cov[2, 2])
        iid_se[i] = np.sqrt((resid @ resid / dof) * sla.inv(X.T @ X)[2, 2])
    assert hac_se.mean() > 1.25 * iid_se.mean()  # HAC widens for autocorrelation


# ---------- diagnostics: Durbin-Watson + Bartlett lag ----------

def test_durbin_watson_flags_autocorrelation():
    # White noise -> DW ~ 2 (no serial correlation); strong AR(1) -> DW well below 2.
    dw_white = np.mean([
        segmented_ols(_make(200, 200, [0.0, 0.0, 1.0, 0.0], sigma=2.0, seed=i)).durbin_watson
        for i in range(40)
    ])
    dw_ar = np.mean([
        segmented_ols(_make(200, 200, [0.0, 0.0, 1.0, 0.0], sigma=2.0, seed=i, rho=0.7)).durbin_watson
        for i in range(40)
    ])
    assert dw_white == pytest.approx(2.0, abs=0.2)
    assert dw_ar < 1.0  # positive autocorrelation pushes DW toward 0


@pytest.mark.parametrize("n", [56, 100, 150, 400])
def test_hac_lag_matches_bartlett_rule(n):
    half = n // 2
    fit = segmented_ols(_make(half, n - half, [1.0, 0.1, 2.0, 0.0], sigma=1.0, seed=1))
    assert fit.hac_lag == hac_lag(n)
    assert fit.hac_lag == int(np.floor(4.0 * (n / 100.0) ** (2.0 / 9.0)))


def test_resid_var_recovers_noise():
    fit = segmented_ols(_make(300, 300, [0.0, 0.0, 1.0, 0.0], sigma=3.0, seed=1))
    assert fit.resid_var == pytest.approx(9.0, rel=0.1)  # sigma^2


# ---------- boundary: the >=28-per-side gate ----------

@pytest.mark.parametrize("n_pre,n_post,k", [
    (28, 28, 4),   # both exactly at the floor -> post_slope fitted
    (27, 28, 3),   # pre just under -> dropped
    (28, 27, 3),   # post just under -> dropped
    (100, 27, 3),
])
def test_post_slope_gate(n_pre, n_post, k):
    truth = [1.0, 0.1, 2.0] + ([0.3] if k == 4 else [])
    fit = segmented_ols(_make(n_pre, n_post, truth))
    assert fit.coeffs.shape == (k,)
    assert fit.n_pre == n_pre and fit.n_post == n_post
    assert not fit.degenerate


# ---------- adversarial: degenerate inputs never raise / never NaN ----------

def _no_nan(fit):
    assert not np.isnan(fit.coeffs).any()
    assert not np.isnan(fit.cov).any()
    assert not np.isnan(fit.resid_var)


def test_flat_metric_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    fit = segmented_ols(Series(dates, np.full(n, 5.0), split=30))
    assert fit.degenerate
    _no_nan(fit)


def test_split_at_start_is_degenerate():
    # split=0 => D is all ones, collinear with the intercept (rank-deficient).
    fit = segmented_ols(_make(0, 50, [1.0, 0.1, 2.0]))
    assert fit.degenerate
    assert fit.cond_number > _COND_MAX_PROBE
    _no_nan(fit)


def test_split_at_end_is_degenerate():
    # split=n => D is all zeros (a null column), rank-deficient.
    n = 50
    dates = _BASE + np.arange(n)
    y = np.linspace(0, 10, n)
    fit = segmented_ols(Series(dates, y, split=n))
    assert fit.degenerate
    _no_nan(fit)


def test_too_few_points_is_degenerate():
    dates = _BASE + np.arange(2)
    fit = segmented_ols(Series(dates, np.array([1.0, 2.0]), split=1))
    assert fit.degenerate
    assert fit.coeffs.shape == (3,)
    _no_nan(fit)


def test_nan_input_is_degenerate_not_raised():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0, 10, n)
    y[5] = np.nan
    fit = segmented_ols(Series(dates, y, split=30))
    assert fit.degenerate
    _no_nan(fit)


def test_inf_input_is_degenerate_not_raised():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0, 10, n)
    y[10] = np.inf
    fit = segmented_ols(Series(dates, y, split=30))
    assert fit.degenerate
    _no_nan(fit)


_COND_MAX_PROBE = 1e10  # keep in step with segmented_ols._COND_MAX
