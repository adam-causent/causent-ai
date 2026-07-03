"""Golden-data + adversarial tests for C7 power_mde.

Truth: the detrend residual variance is recovered exactly from a residual planted
orthogonal to span{1, t}, so the MDE is a KNOWN closed-form value. scipy
(linregress + t.ppf) re-derives the whole proxy independently as the oracle for
the estimate and the underpowered decision. scipy is a TEST-ONLY oracle; the
shipped engine is numpy-only.
"""

import math

import numpy as np
import pytest
from scipy import stats

from causal.power_mde import power_mde
from causal.t_ppf import t_ppf
from causal.types import PowerResult, Series

_BASE = 738000  # arbitrary ordinal-day offset; centering absorbs it


def _series(pre, n_post=20):
    """Wrap a pre-history in a Series with an (unused-by-the-proxy) post side."""
    n_pre = pre.size
    dates = _BASE + np.arange(n_pre + n_post)
    values = np.concatenate([pre, np.zeros(n_post)])
    return Series(dates, values, split=n_pre)


def _oracle(series, target_frac=0.05, alpha=0.05, power=0.8):
    """Independent scipy re-derivation of the whole proxy for one pre-history."""
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


# ---------- golden: recovery of a KNOWN residual variance -> KNOWN mde ----------

def test_recovers_known_mde_from_orthogonal_residual():
    # r = u^2 - mean(u^2) is orthogonal to {1, t}, so the detrend leaves it exactly:
    # residual SS is the analytically-known c^2 * (r @ r), independent of the fit.
    n_pre = 40
    u = np.arange(n_pre) - (n_pre - 1) / 2.0
    r = u * u - (u * u).mean()
    c = 0.01
    pre = 100.0 + 0.5 * np.arange(n_pre) + c * r
    res = power_mde(_series(pre))

    df = n_pre - 2
    known_var = c * c * float(r @ r) / df
    known_mde = (t_ppf(0.975, df) + t_ppf(0.8, df)) * math.sqrt(known_var * 2.0 / n_pre)
    assert res.mde == pytest.approx(known_mde, rel=1e-9)
    assert res.underpowered is False  # mde ~ 5e-3 << 0.05 * ~109 mean


def test_matches_scipy_oracle_noisy():
    rng = np.random.default_rng(7)
    n_pre = 90
    pre = 50.0 + 0.2 * np.arange(n_pre) + rng.normal(0.0, 3.0, n_pre)
    res = power_mde(_series(pre))
    o_mde, o_under = _oracle(_series(pre))
    assert res.mde == pytest.approx(o_mde, rel=1e-9)
    assert res.underpowered is o_under


# ---------- boundary: the underpowered decision flips at the threshold ----------

def test_underpowered_true_when_noise_dwarfs_target():
    # Huge relative noise, tiny target fraction -> mde far exceeds 0.001 * mean.
    rng = np.random.default_rng(1)
    pre = 100.0 + rng.normal(0.0, 40.0, 60)
    res = power_mde(_series(pre), target_frac=0.001)
    o_mde, o_under = _oracle(_series(pre), target_frac=0.001)
    assert res.underpowered is True and o_under is True
    assert res.mde == pytest.approx(o_mde, rel=1e-9)


def test_underpowered_false_when_series_is_quiet():
    # Near-linear, low noise, generous target -> comfortably powered.
    rng = np.random.default_rng(2)
    pre = 100.0 + 0.5 * np.arange(60) + rng.normal(0.0, 0.05, 60)
    res = power_mde(_series(pre), target_frac=0.2)
    o_mde, o_under = _oracle(_series(pre), target_frac=0.2)
    assert res.underpowered is False and o_under is False
    assert res.mde == pytest.approx(o_mde, rel=1e-9)


# ---------- boundary: perfectly linear pre-history -> zero-variance MDE ----------

def test_linear_pre_history_gives_zero_mde():
    pre = 10.0 + 2.0 * np.arange(50)
    res = power_mde(_series(pre))
    assert res.mde == pytest.approx(0.0, abs=1e-6)
    assert res.underpowered is False


# ---------- boundary: minimum df = 1 still computes; df = 0 does not ----------

def test_three_points_is_the_minimum():
    u = np.arange(3) - 1.0
    pre = 5.0 + u * u - (u * u).mean()   # df = 1, heavy-tailed but defined
    res = power_mde(_series(pre))
    assert res.mde is not None and math.isfinite(res.mde)
    o_mde, _ = _oracle(_series(pre))
    assert res.mde == pytest.approx(o_mde, rel=1e-8)


def test_two_points_is_underpowered_none():
    res = power_mde(_series(np.array([5.0, 6.0])))
    assert res == PowerResult(None, True)


# ---------- adversarial: degenerate inputs never fabricate an mde ----------

def test_nan_in_pre_history_is_none_underpowered():
    pre = 100.0 + 0.5 * np.arange(40)
    pre[10] = np.nan
    res = power_mde(_series(pre))
    assert res == PowerResult(None, True)


def test_inf_in_pre_history_is_none_underpowered():
    pre = 100.0 + 0.5 * np.arange(40)
    pre[3] = np.inf
    res = power_mde(_series(pre))
    assert res == PowerResult(None, True)


def test_duplicate_dates_rank_deficient_is_none_underpowered():
    # Contract violation (non-unique dates) collapses the time axis -> no defensible mde.
    dates = np.concatenate([np.full(30, _BASE), _BASE + np.arange(20)])
    values = np.zeros(50)
    res = power_mde(Series(dates, values, split=30))
    assert res == PowerResult(None, True)


# ---------- adversarial: caller errors on the confidence knobs ----------

@pytest.mark.parametrize("alpha", [0.0, 1.0, -0.1, 1.5, float("nan")])
def test_bad_alpha_raises(alpha):
    with pytest.raises(ValueError):
        power_mde(_series(100.0 + np.arange(40.0)), alpha=alpha)


@pytest.mark.parametrize("power", [0.0, 1.0, -0.1, 2.0, float("nan")])
def test_bad_power_raises(power):
    with pytest.raises(ValueError):
        power_mde(_series(100.0 + np.arange(40.0)), power=power)
