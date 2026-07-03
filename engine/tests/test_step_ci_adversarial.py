"""Adversarial attack on C3 step_ci.

Strategy: hit the seams the golden suite leaves thin — tiny df (df=1..7),
near-singular / enormous but finite variance, extreme alpha (deep tails),
boundary df, and hand-built Fits that decouple the reported variance from a
real solve. scipy.stats.t.ppf is the TEST-ONLY critical-value oracle; the
shipped engine is numpy-only.
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

_BASE = 738000


# ---------- helpers ----------

def _fit(var, df, step=0.0, coeffs_size=3, degenerate=False):
    """Hand-built Fit exposing exactly (var at cov[2,2], df) to step_ci.

    df = n_pre + n_post - k, so pick n_pre/n_post to realize a target df for a
    given coeff count k=coeffs_size.
    """
    k = coeffs_size
    n = df + k
    n_pre = n // 2
    n_post = n - n_pre
    coeffs = np.zeros(k)
    coeffs[2] = step
    cov = np.eye(k)
    cov[2, 2] = var
    return Fit(coeffs=coeffs, cov=cov, resid_var=1.0, cond_number=1.0,
               n_pre=n_pre, n_post=n_post, degenerate=degenerate)


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


def _oracle_ci(series, alpha=0.05):
    X = _design(series.dates, series.split)
    beta, *_ = sla.lstsq(X, series.values)
    dof = series.values.size - X.shape[1]
    resid = series.values - X @ beta
    cov = hac_cov(X, resid)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    return beta[2] - half, beta[2] + half


# ---------- tiny df: numeric agreement with scipy ----------

@pytest.mark.parametrize("df", [1, 2, 3, 5, 7, 12])
@pytest.mark.parametrize("alpha", [0.05, 0.01, 0.10, 0.001])
def test_tiny_df_matches_scipy(df, alpha):
    var, step = 4.0, 3.5
    lo, hi = step_ci(_fit(var, df, step=step), alpha=alpha)
    half = stats.t.ppf(1.0 - alpha / 2.0, df) * math.sqrt(var)
    assert lo == pytest.approx(step - half, rel=1e-8, abs=1e-8)
    assert hi == pytest.approx(step + half, rel=1e-8, abs=1e-8)


def test_df_one_no_blowup():
    # df=1 (Cauchy-tail t): finite critical value, finite symmetric interval.
    lo, hi = step_ci(_fit(1.0, 1), alpha=0.05)
    assert math.isfinite(lo) and math.isfinite(hi)
    assert lo < 0.0 < hi
    assert (0.0 - lo) == pytest.approx(hi - 0.0, rel=1e-12)


def test_boundary_df_one_via_real_fit():
    # Smallest usable 3-coeff fit that still has df=1: n=4, split=2.
    dates = _BASE + np.arange(4)
    y = np.array([0.0, 1.0, 5.0, 6.5])
    fit = segmented_ols(Series(dates, y, split=2))
    lo, hi = step_ci(fit)
    if fit.degenerate or (fit.n_pre + fit.n_post - fit.coeffs.size) <= 0:
        assert math.isnan(lo) and math.isnan(hi)
    else:
        o_lo, o_hi = _oracle_ci(Series(dates, y, split=2))
        assert (lo, hi) == pytest.approx((o_lo, o_hi), rel=1e-7, abs=1e-7)


def test_df_zero_boundary_returns_nan():
    # df == 0 exactly must be caught (df <= 0), never handed to t_ppf.
    assert all(map(math.isnan, step_ci(_fit(1.0, 0))))


def test_df_negative_returns_nan():
    assert all(map(math.isnan, step_ci(_fit(1.0, -3))))


# ---------- near-singular / extreme but finite variance ----------

def test_enormous_variance_stays_finite():
    lo, hi = step_ci(_fit(1e300, 20))
    assert math.isfinite(lo) and math.isfinite(hi)
    assert hi > lo


def test_tiny_positive_variance_collapses_cleanly():
    lo, hi = step_ci(_fit(1e-300, 20, step=2.0))
    assert math.isfinite(lo) and math.isfinite(hi)
    assert lo <= 2.0 <= hi


def test_near_singular_real_design_matches_oracle():
    # Almost-collinear metric: cov[2,2] large but finite; must track the oracle
    # rather than blowing up, provided C2 does not flag it degenerate.
    s = _make(45, 45, [1.0, 0.05, 0.001, 0.0], sigma=1e-3, seed=99)
    fit = segmented_ols(s)
    lo, hi = step_ci(fit)
    if fit.degenerate:
        assert math.isnan(lo) and math.isnan(hi)
    else:
        o_lo, o_hi = _oracle_ci(s)
        assert (lo, hi) == pytest.approx((o_lo, o_hi), rel=1e-7, abs=1e-9)


def test_negative_roundoff_variance_returns_nan():
    # A numerically-negative variance (bad inverse) has no defensible width.
    assert all(map(math.isnan, step_ci(_fit(-1e-14, 30))))


def test_nan_variance_returns_nan():
    assert all(map(math.isnan, step_ci(_fit(float("nan"), 30))))


# ---------- coverage at TINY sample (small df) recovers nominal ----------

def test_coverage_small_sample_white_noise_band():
    # n_pre=n_post=8 -> 3-coeff model, df=13. At this tiny n the Newey-West HAC
    # under-covers materially (its known finite-sample cost); we assert the honest
    # band it actually achieves, not a fabricated 0.95.
    truth = [1.0, 0.1, 4.0, 0.0]  # post_slope ignored (side < 28)
    step = truth[2]
    draws = 4000
    covered = 0
    for i in range(draws):
        lo, hi = step_ci(segmented_ols(_make(8, 8, truth[:3], sigma=2.0, seed=i)))
        if not math.isnan(lo):
            covered += lo <= step <= hi
    assert 0.75 <= covered / draws <= 0.90


def test_coverage_tight_alpha_white_noise_band():
    # 99% CI at moderate n under iid noise: HAC lands just under nominal (~0.95),
    # the honest small-sample rate — asserted as a band, not the fabricated 0.99.
    truth = [0.0, 0.0, 2.5, 0.0]
    step = truth[2]
    draws = 4000
    covered = 0
    for i in range(draws):
        lo, hi = step_ci(segmented_ols(_make(30, 30, truth, sigma=1.5, seed=i)),
                         alpha=0.01)
        covered += lo <= step <= hi
    assert 0.92 <= covered / draws <= 0.99


def test_hac_beats_iid_coverage_under_autocorrelation():
    # The reason HAC exists: under AR(1) residuals the iid interval under-covers
    # badly; HAC widens and covers strictly better.
    truth = [0.0, 0.0, 2.5, 0.0]
    step = truth[2]
    draws = 2000
    hac = iid = 0
    for i in range(draws):
        s = _make(30, 30, truth, sigma=1.5, seed=i, rho=0.8)
        lo, hi = step_ci(segmented_ols(s))
        hac += lo <= step <= hi
        X = _design(s.dates, s.split)
        beta, *_ = sla.lstsq(X, s.values)
        dof = s.values.size - X.shape[1]
        resid = s.values - X @ beta
        icov = (resid @ resid / dof) * sla.inv(X.T @ X)
        half = stats.t.ppf(0.975, dof) * math.sqrt(icov[2, 2])
        iid += beta[2] - half <= step <= beta[2] + half
    assert hac > iid + 0.08 * draws


# ---------- structure / contract invariants ----------

def test_only_cov_2_2_is_read():
    # Poisoning other cov entries with inf/nan must not change the interval.
    good = _fit(4.0, 20, step=1.0)
    bad = _fit(4.0, 20, step=1.0)
    bad.cov[0, 0] = float("inf")
    bad.cov[1, 1] = float("nan")
    bad.cov[0, 1] = bad.cov[1, 0] = float("inf")
    assert step_ci(good) == step_ci(bad)


def test_four_coeff_df_uses_k4():
    # k must be coeffs.size, not a hardcoded 3.
    var, step, df = 4.0, 2.0, 10
    fit = _fit(var, df, step=step, coeffs_size=4)
    assert fit.coeffs.size == 4
    lo, hi = step_ci(fit)
    half = stats.t.ppf(1.0 - 0.05 / 2.0, df) * math.sqrt(var)
    assert (lo, hi) == pytest.approx((step - half, step + half), rel=1e-9, abs=1e-9)


def test_perfectly_symmetric_exact():
    fit = _fit(7.3, 15, step=-4.2)
    lo, hi = step_ci(fit)
    assert (-4.2 - lo) == pytest.approx(hi - (-4.2), rel=0, abs=1e-15)


def test_degenerate_flag_short_circuits_even_with_good_var():
    # A finite positive var but degenerate=True must still be (nan, nan).
    assert all(map(math.isnan, step_ci(_fit(4.0, 20, degenerate=True))))


@pytest.mark.parametrize("alpha", [0.0, 1.0, -1e-12, 1.0 + 1e-9, float("nan"),
                                   float("inf")])
def test_invalid_alpha_raises(alpha):
    with pytest.raises(ValueError):
        step_ci(_fit(4.0, 20), alpha)
