"""Adversarial tests for C7 power_mde — written by a reviewer who did NOT write
the component and is trying to break it.

Strategy:
  * Robustness/degenerate/boundary inputs must never crash or fabricate an mde.
  * scipy (linregress + t.ppf) is an independent TEST-ONLY oracle for the numeric
    estimate across a fuzz of seeds and df sizes (df = 1 .. large).
  * The two tests at the bottom encode the component's OWN stated semantics
    ("any effect detectable", "smallest effect we'd care about") for
    negative-baseline metrics — they pin the |mean| threshold fix (C7 defect,
    previously xfail).
"""

import math

import numpy as np
import pytest
from scipy import stats

from causal.power_mde import power_mde
from causal.types import PowerResult, Series

_BASE = 738000


def _series(pre, n_post=20, base=_BASE):
    pre = np.asarray(pre, dtype=np.float64)
    n_pre = pre.size
    dates = base + np.arange(n_pre + n_post)
    values = np.concatenate([pre, np.zeros(n_post)])
    return Series(dates, values, split=n_pre)


def _oracle(series, target_frac=0.05, alpha=0.05, power=0.8):
    """Independent scipy re-derivation of the whole proxy."""
    n_pre = series.split
    y = series.values[:n_pre].astype(float)
    t = series.dates[:n_pre].astype(float)
    slope, intercept, *_ = stats.linregress(t, y)
    resid = y - (intercept + slope * t)
    df = n_pre - 2
    var = resid @ resid / df
    mde = (stats.t.ppf(1 - alpha / 2, df) + stats.t.ppf(power, df)) \
        * math.sqrt(var * 2.0 / n_pre)
    return mde, bool(mde > target_frac * y.mean())


# ---------------- fuzz vs scipy: many seeds, many df, extreme scales ----------

@pytest.mark.parametrize("n_pre", [3, 4, 5, 10, 37, 128, 501])
@pytest.mark.parametrize("seed", range(6))
def test_fuzz_matches_scipy_oracle(n_pre, seed):
    rng = np.random.default_rng(1000 * seed + n_pre)
    level = rng.uniform(20.0, 500.0)          # positive baseline: oracle & code agree
    slope = rng.uniform(-2.0, 2.0)
    sigma = rng.uniform(0.5, 25.0)
    pre = level + slope * np.arange(n_pre) + rng.normal(0.0, sigma, n_pre)
    s = _series(pre)
    res = power_mde(s)
    o_mde, o_under = _oracle(s)
    assert res.mde == pytest.approx(o_mde, rel=1e-8, abs=1e-12)
    assert res.underpowered is o_under
    assert isinstance(res.mde, float) and isinstance(res.underpowered, bool)


@pytest.mark.parametrize("alpha,power", [(0.01, 0.9), (0.10, 0.5001), (0.001, 0.99)])
def test_fuzz_nonstandard_knobs_match_scipy(alpha, power):
    rng = np.random.default_rng(99)
    pre = 200.0 + 0.3 * np.arange(75) + rng.normal(0.0, 8.0, 75)
    s = _series(pre)
    res = power_mde(s, alpha=alpha, power=power)
    o_mde, o_under = _oracle(s, alpha=alpha, power=power)
    assert res.mde == pytest.approx(o_mde, rel=1e-7)
    assert res.underpowered is o_under


def test_df_one_heavy_tail_matches_scipy():
    # df = 1 (n_pre = 3) exercises the heavy-tail branch of t_ppf inside the proxy.
    pre = np.array([10.0, 9.0, 14.0])
    s = _series(pre)
    res = power_mde(s)
    o_mde, o_under = _oracle(s)
    assert res.mde == pytest.approx(o_mde, rel=1e-7)
    assert res.underpowered is o_under


# ---------------- scale extremes: huge magnitudes must not fabricate ----------

def test_overflow_variance_returns_none_not_inf():
    rng = np.random.default_rng(5)
    pre = 1e200 + rng.normal(0.0, 1e199, 40)   # resid @ resid overflows -> +inf
    res = power_mde(_series(pre))
    assert res == PowerResult(None, True)       # never a non-finite mde


def test_tiny_scale_stays_finite_and_matches_scipy():
    rng = np.random.default_rng(6)
    pre = 1e-6 + rng.normal(0.0, 1e-9, 50)
    s = _series(pre)
    res = power_mde(s)
    o_mde, _ = _oracle(s)
    assert res.mde is not None and math.isfinite(res.mde)
    assert res.mde == pytest.approx(o_mde, rel=1e-6, abs=1e-18)


# ---------------- zero-variance / constant series ----------------------------

def test_constant_positive_series_zero_mde_not_underpowered():
    res = power_mde(_series(np.full(40, 50.0)))
    assert res.mde == pytest.approx(0.0, abs=1e-9)
    assert res.underpowered is False            # zero variance => everything detectable

def test_all_zero_series_zero_mde_threshold_zero():
    # mean == 0 => threshold 0; mde == 0 is NOT > 0 => not underpowered.
    res = power_mde(_series(np.zeros(30)))
    assert res.mde == pytest.approx(0.0, abs=1e-12)
    assert res.underpowered is False


# ---------------- degenerate / malformed inputs never crash ------------------

def test_split_zero_is_none_underpowered():
    d = _BASE + np.arange(30)
    res = power_mde(Series(d, np.zeros(30), split=0))
    assert res == PowerResult(None, True)

def test_negative_split_is_none_underpowered():
    d = _BASE + np.arange(30)
    res = power_mde(Series(d, np.zeros(30), split=-4))
    assert res == PowerResult(None, True)

def test_nan_and_inf_anywhere_in_pre_is_none():
    for bad in (np.nan, np.inf, -np.inf):
        pre = 100.0 + 0.5 * np.arange(40)
        pre[17] = bad
        assert power_mde(_series(pre)) == PowerResult(None, True)

def test_all_identical_dates_rank_deficient_is_none():
    dates = np.full(40, _BASE)
    res = power_mde(Series(dates, 100.0 + np.arange(40.0), split=40))
    assert res == PowerResult(None, True)

def test_non_monotonic_but_valid_dates_still_compute():
    # dates need only span rank 2; wildly spaced integer days are fine.
    rng = np.random.default_rng(11)
    dates = _BASE + np.array([0, 1, 5, 6, 20, 21, 100, 101, 500, 900])
    pre = 100.0 + rng.normal(0.0, 2.0, dates.size)
    values = np.concatenate([pre, np.zeros(5)])
    all_dates = np.concatenate([dates, dates[-1] + 1 + np.arange(5)])
    s = Series(all_dates, values, split=dates.size)
    res = power_mde(s)
    # Oracle uses the same raw t axis.
    slope, intercept, *_ = stats.linregress(dates.astype(float), pre)
    resid = pre - (intercept + slope * dates.astype(float))
    df = dates.size - 2
    o_mde = (stats.t.ppf(0.975, df) + stats.t.ppf(0.8, df)) * math.sqrt((resid @ resid / df) * 2.0 / dates.size)
    assert res.mde == pytest.approx(o_mde, rel=1e-7)


# ---------------- confidence-knob validation --------------------------------

@pytest.mark.parametrize("alpha", [0.0, 1.0, -1e-9, 1.0 + 1e-9, float("nan"), float("inf")])
def test_bad_alpha_raises(alpha):
    with pytest.raises(ValueError):
        power_mde(_series(100.0 + np.arange(40.0)), alpha=alpha)

@pytest.mark.parametrize("power", [0.0, 1.0, -1e-9, 1.0 + 1e-9, float("nan"), float("inf")])
def test_bad_power_raises(power):
    with pytest.raises(ValueError):
        power_mde(_series(100.0 + np.arange(40.0)), power=power)


# ================================================================= DEFECT ====
# The `underpowered` gate compares mde against a *signed* threshold
# `target_frac * mean(pre)`. For any metric with a NEGATIVE baseline mean the
# threshold is negative, so mde (always >= 0) exceeds it unconditionally and the
# series is flagged underpowered no matter how clean or detectable it is. This
# contradicts the component's own stated invariant ("a perfectly linear
# pre-history -> mde=0.0, any effect detectable") and is a statistical error:
# detectability should be measured against the *magnitude* of the baseline,
# |mean(pre)|, not its sign. Root cause: `target_frac * float(pre.mean())`
# should be `target_frac * abs(float(pre.mean()))`.

def test_zero_variance_negative_baseline_is_not_underpowered():
    # Perfectly linear, negative baseline: mde == 0.0 => any effect detectable,
    # so the metric CANNOT be underpowered.
    pre = -100.0 - 2.0 * np.arange(40)
    res = power_mde(_series(pre))
    assert res.mde == pytest.approx(0.0, abs=1e-6)
    assert res.underpowered is False


def test_clean_negative_baseline_series_is_well_powered():
    # Flat baseline at -50 with tiny noise: mde ~ 0.01, magnitude threshold
    # 0.05 * 50 = 2.5, so mde << target => clearly well powered.
    rng = np.random.default_rng(3)
    pre = -50.0 + rng.normal(0.0, 0.02, 60)
    res = power_mde(_series(pre), target_frac=0.05)
    assert res.mde is not None and res.mde < 0.05 * abs(pre.mean())
    assert res.underpowered is False
