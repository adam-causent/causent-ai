"""Adversarial tests for C4 its_readout — an independent attempt to break it.

These are written by a reviewer who did NOT write the component. The goal is to
falsify the contract:

  its_readout(series) -> ITSResult
    * gate n_pre>=14 and n_post>=14 else INSUFFICIENT
    * run segmented_ols; if fit.degenerate -> DEGENERATE
    * else step_ci -> lift + CI; direction = sign(lift) when CI excludes 0
      else INCONCLUSIVE; fill n_pre/n_post/resid_var/cond_number.
    * NEVER returns a fabricated number.

scipy is the TEST-ONLY oracle (lstsq + inv + t.ppf), independent of the numpy
engine. Attack axes: n=14 vs 13 boundary, degenerate -> DEGENERATE, CI straddling
0 -> INCONCLUSIVE, strong negative -> NEGATIVE (not low-belief), and byte-level
NaN/inf leakage into results.
"""

import math

import numpy as np
import pytest
from scipy import linalg as sla
from scipy import stats

from causal.its_readout import its_readout
from causal.types import ITSResult, Series

_BASE = 738000


# ---------- independent oracle (mirrors C2's design; does NOT import it) ----------

def _design(dates, split):
    t = dates.astype(np.float64)
    n = t.size
    post = np.arange(n) >= split
    cols = [np.ones(n), t - t.mean(), post.astype(np.float64)]
    # 4th column iff both sides have >= 28 points (the C2 rule).
    if split >= 28 and n - split >= 28:
        cols.append(np.where(post, t - t[split], 0.0))
    return np.column_stack(cols)


def _oracle(series, alpha=0.05):
    """Return (lift, ci_low, ci_high) end-to-end from scipy, independent of engine."""
    X = _design(series.dates, series.split)
    beta, *_ = sla.lstsq(X, series.values)
    dof = series.values.size - X.shape[1]
    resid = series.values - X @ beta
    cov = (resid @ resid / dof) * sla.inv(X.T @ X)
    half = stats.t.ppf(1.0 - alpha / 2.0, dof) * math.sqrt(cov[2, 2])
    return beta[2], beta[2] - half, beta[2] + half


def _make(n_pre, n_post, truth, sigma=0.0, seed=0):
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    X = _design(dates, n_pre)
    # Pad/trim the truth vector to the design width (4th coeff appears at 28/28).
    b = np.zeros(X.shape[1])
    b[: min(len(truth), X.shape[1])] = np.asarray(truth, float)[: X.shape[1]]
    y = X @ b
    if sigma:
        y = y + np.random.default_rng(seed).normal(0.0, sigma, n)
    return Series(dates=dates, values=y, split=n_pre)


def _assert_no_fabrication_when_not_ok(r: ITSResult):
    """A non-OK readout must not carry lift/CI numbers and must be INCONCLUSIVE."""
    assert r.status != "OK"
    assert r.lift is None
    assert r.ci_low is None
    assert r.ci_high is None
    assert r.direction == "INCONCLUSIVE"


def _assert_finite_or_none(x):
    assert x is None or math.isfinite(x)


# ======================================================================
# 1. BOUNDARY: the 14-per-side gate, attacked from both sides & orders
# ======================================================================

@pytest.mark.parametrize("n_pre,n_post,expect", [
    (14, 14, "OK"),
    (14, 15, "OK"),
    (15, 14, "OK"),
    (13, 14, "INSUFFICIENT"),
    (14, 13, "INSUFFICIENT"),
    (13, 13, "INSUFFICIENT"),
    (13, 40, "INSUFFICIENT"),
    (40, 13, "INSUFFICIENT"),
    (14, 100, "OK"),
])
def test_boundary_gate_exhaustive(n_pre, n_post, expect):
    # Give the fittable cases real signal + noise so an OK verdict is meaningful.
    r = its_readout(_make(n_pre, n_post, [1.0, 0.1, 3.0], sigma=0.5, seed=3))
    assert r.status == expect
    # Counts must always reflect the true split, even when INSUFFICIENT.
    assert r.n_pre == n_pre
    assert r.n_post == n_post
    if expect != "OK":
        _assert_no_fabrication_when_not_ok(r)


def test_boundary_14_14_actually_fits_and_matches_oracle():
    # Exactly at the floor with clean signal: must recover the truth, not bail.
    s = _make(14, 14, [2.0, 0.2, 4.0], sigma=0.0)
    r = its_readout(s)
    assert r.status == "OK"
    assert r.lift == pytest.approx(4.0, abs=1e-6)


def test_gate_uses_size_minus_split_not_a_stored_field():
    # split index computed n_post = size - split. 13 post -> INSUFFICIENT.
    n = 27  # 14 pre + 13 post
    dates = _BASE + np.arange(n)
    y = np.linspace(0.0, 5.0, n) + np.random.default_rng(1).normal(0, 0.3, n)
    r = its_readout(Series(dates, y, split=14))
    assert r.status == "INSUFFICIENT"
    assert r.n_pre == 14 and r.n_post == 13


# ======================================================================
# 2. NUMERIC ORACLE agreement across 3-coeff and 4-coeff regimes
# ======================================================================

@pytest.mark.parametrize("n_pre,n_post,truth,sigma,seed", [
    (50, 45, [2.0, 0.3, 5.0, -0.1], 1.5, 7),    # 4-coeff (both >= 28)
    (30, 30, [1.0, 0.05, 3.0, 0.0], 2.0, 11),   # 4-coeff, weaker
    (20, 20, [1.0, 0.1, 4.0], 1.0, 5),          # 3-coeff (both < 28)
    (28, 20, [0.0, 0.0, -6.0], 1.2, 9),         # asymmetric -> 3-coeff
    (28, 28, [3.0, -0.2, 2.5, 0.05], 0.8, 2),   # exactly 28/28 -> 4-coeff
])
def test_lift_and_ci_match_scipy(n_pre, n_post, truth, sigma, seed):
    s = _make(n_pre, n_post, truth, sigma=sigma, seed=seed)
    r = its_readout(s)
    assert r.status == "OK"
    o_lift, o_lo, o_hi = _oracle(s)
    assert r.lift == pytest.approx(o_lift, rel=1e-8, abs=1e-8)
    assert r.ci_low == pytest.approx(o_lo, rel=1e-7, abs=1e-7)
    assert r.ci_high == pytest.approx(o_hi, rel=1e-7, abs=1e-7)


def test_direction_always_agrees_with_oracle_ci():
    # Sweep many random draws; readout's direction must match what the oracle CI says.
    rng = np.random.default_rng(0)
    for _ in range(200):
        n_pre = int(rng.integers(15, 40))
        n_post = int(rng.integers(15, 40))
        step = float(rng.uniform(-6, 6))
        sigma = float(rng.uniform(0.5, 4.0))
        seed = int(rng.integers(0, 10_000))
        s = _make(n_pre, n_post, [1.0, 0.05, step], sigma=sigma, seed=seed)
        r = its_readout(s)
        assert r.status == "OK"
        _, o_lo, o_hi = _oracle(s)
        if o_lo > 0.0:
            expect = "POSITIVE"
        elif o_hi < 0.0:
            expect = "NEGATIVE"
        else:
            expect = "INCONCLUSIVE"
        assert r.direction == expect, (r.direction, expect, o_lo, o_hi)


# ======================================================================
# 3. DIRECTION semantics: strong negative -> NEGATIVE; straddle -> INCONCLUSIVE
# ======================================================================

def test_strong_negative_is_negative_not_inconclusive():
    # Large negative step, tiny noise: CI must clear 0 on the negative side.
    s = _make(30, 30, [5.0, 0.0, -9.0], sigma=0.3, seed=4)
    r = its_readout(s)
    assert r.status == "OK"
    assert r.lift < 0.0
    _, o_lo, o_hi = _oracle(s)
    assert o_hi < 0.0  # oracle agrees CI excludes 0 negatively
    assert r.direction == "NEGATIVE"


def test_strong_positive_is_positive():
    s = _make(30, 30, [1.0, 0.0, 9.0], sigma=0.3, seed=6)
    r = its_readout(s)
    assert r.direction == "POSITIVE"
    assert r.lift > 0.0


def test_ci_straddling_zero_is_inconclusive_but_still_reports_lift():
    # Tiny true effect drowned in noise -> CI straddles 0 -> INCONCLUSIVE,
    # yet lift/CI are still REAL numbers (honest, not None): status stays OK.
    s = _make(20, 20, [1.0, 0.0, 0.05], sigma=5.0, seed=8)
    r = its_readout(s)
    assert r.status == "OK"
    _, o_lo, o_hi = _oracle(s)
    assert o_lo < 0.0 < o_hi  # oracle confirms straddle
    assert r.direction == "INCONCLUSIVE"
    assert r.lift is not None  # does NOT suppress the number just because unsure
    assert r.ci_low is not None and r.ci_high is not None
    assert r.ci_low < 0.0 < r.ci_high


def test_exact_null_step_is_inconclusive_at_zero_noise():
    # Zero true step, zero noise: lift == 0 exactly, CI == (0,0), not POSITIVE/NEGATIVE.
    s = _make(20, 20, [3.0, 0.4, 0.0], sigma=0.0)
    r = its_readout(s)
    assert r.status == "OK"
    assert r.lift == pytest.approx(0.0, abs=1e-9)
    assert r.direction == "INCONCLUSIVE"  # ci_low>0 False, ci_high<0 False


def test_null_false_positive_rate_matches_nominal_alpha():
    truth = [1.0, 0.05, 0.0, 0.0]
    draws = 1500
    fp = 0
    for i in range(draws):
        r = its_readout(_make(30, 30, truth, sigma=2.0, seed=100_000 + i))
        assert r.status == "OK" and r.lift is not None
        fp += r.direction != "INCONCLUSIVE"
    assert fp / draws == pytest.approx(0.05, abs=0.025)


# ======================================================================
# 4. DEGENERATE: must be DEGENERATE (not OK, not a raise, no number leak)
# ======================================================================

def test_flat_constant_metric_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    r = its_readout(Series(dates, np.full(n, 7.0), split=30))
    assert r.status == "DEGENERATE"
    _assert_no_fabrication_when_not_ok(r)
    _assert_finite_or_none(r.resid_var)
    _assert_finite_or_none(r.cond_number)


def test_subfloor_variance_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(5.0, 5.0 + 1e-8, n)  # variance far below the floor
    r = its_readout(Series(dates, y, split=30))
    assert r.status == "DEGENERATE"
    _assert_no_fabrication_when_not_ok(r)


def test_nan_value_does_not_crash_and_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0.0, 10.0, n).copy()
    y[7] = np.nan
    r = its_readout(Series(dates, y, split=30))
    assert r.status == "DEGENERATE"
    _assert_no_fabrication_when_not_ok(r)
    _assert_finite_or_none(r.resid_var)
    _assert_finite_or_none(r.cond_number)


def test_inf_value_does_not_crash_and_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0.0, 10.0, n).copy()
    y[42] = np.inf
    r = its_readout(Series(dates, y, split=30))
    assert r.status == "DEGENERATE"
    _assert_no_fabrication_when_not_ok(r)
    # cond_number/resid_var must never leak inf/nan into the result.
    _assert_finite_or_none(r.resid_var)
    _assert_finite_or_none(r.cond_number)


def test_neginf_value_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0.0, 10.0, n).copy()
    y[0] = -np.inf
    r = its_readout(Series(dates, y, split=30))
    assert r.status == "DEGENERATE"
    _assert_no_fabrication_when_not_ok(r)


def test_all_nan_is_degenerate():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.full(n, np.nan)
    r = its_readout(Series(dates, y, split=30))
    assert r.status in ("DEGENERATE", "INSUFFICIENT")
    _assert_no_fabrication_when_not_ok(r)


def test_ill_conditioned_dates_do_not_leak_numbers():
    # Enormous, wildly-spaced date magnitudes -> condition blow-up. Whatever the
    # verdict, it must be a clean status with no inf/nan in the result fields.
    n = 60
    dates = _BASE + (np.arange(n) ** 3) * 1_000_000  # unique, sorted, huge span
    y = np.linspace(0.0, 1.0, n) + np.random.default_rng(2).normal(0, 1e-3, n)
    r = its_readout(Series(dates.astype(np.int64), y, split=30))
    assert r.status in ("OK", "DEGENERATE")
    _assert_finite_or_none(r.resid_var)
    _assert_finite_or_none(r.cond_number)
    if r.status == "OK":
        assert r.lift is not None and math.isfinite(r.lift)
        assert math.isfinite(r.ci_low) and math.isfinite(r.ci_high)
    else:
        _assert_no_fabrication_when_not_ok(r)


# ======================================================================
# 5. CONTRACT invariants that must hold for ANY input
# ======================================================================

def test_result_shape_invariants_over_random_and_pathological_inputs():
    rng = np.random.default_rng(123)
    cases = []
    # random well-formed series
    for _ in range(60):
        n_pre = int(rng.integers(1, 40))
        n_post = int(rng.integers(1, 40))
        n = n_pre + n_post
        dates = _BASE + np.arange(n)
        y = rng.normal(0, rng.uniform(0.1, 5), n)
        cases.append(Series(dates, y, split=n_pre))
    # pathological splits
    for split in (0, 1, 59, 60):
        n = 60
        dates = _BASE + np.arange(n)
        y = rng.normal(0, 1, n)
        cases.append(Series(dates, y, split=split))

    for s in cases:
        r = its_readout(s)
        assert r.method == "ITS"
        assert r.status in ("OK", "INSUFFICIENT", "DEGENERATE")
        assert r.direction in ("POSITIVE", "NEGATIVE", "INCONCLUSIVE")
        # lift present iff OK; and it is a bijection with status here.
        if r.status == "OK":
            assert r.lift is not None
            assert r.ci_low is not None and r.ci_high is not None
            assert math.isfinite(r.lift)
            assert math.isfinite(r.ci_low) and math.isfinite(r.ci_high)
            assert r.ci_low <= r.ci_high
            # direction must be consistent with the CI it reports
            if r.direction == "POSITIVE":
                assert r.ci_low > 0.0
            elif r.direction == "NEGATIVE":
                assert r.ci_high < 0.0
            else:
                assert r.ci_low <= 0.0 <= r.ci_high
        else:
            _assert_no_fabrication_when_not_ok(r)
        # diagnostics never leak non-finite
        _assert_finite_or_none(r.resid_var)
        _assert_finite_or_none(r.cond_number)


def test_split_at_very_end_is_insufficient_not_a_crash():
    n = 60
    dates = _BASE + np.arange(n)
    y = np.linspace(0, 5, n)
    for split in (0, 60, 61, 100, -1):
        r = its_readout(Series(dates, y, split=split))
        assert r.status == "INSUFFICIENT"
        _assert_no_fabrication_when_not_ok(r)


def test_negative_direction_never_paired_with_positive_ci():
    # Consistency probe: over a sweep, POSITIVE never co-occurs with lift<0 and
    # NEGATIVE never with lift>0 (guards against a sign/branch swap).
    rng = np.random.default_rng(77)
    for _ in range(150):
        step = float(rng.uniform(-8, 8))
        s = _make(25, 25, [1.0, 0.0, step], sigma=float(rng.uniform(0.3, 3.0)),
                  seed=int(rng.integers(0, 9999)))
        r = its_readout(s)
        if r.direction == "POSITIVE":
            assert r.lift > 0.0 and r.ci_low > 0.0
        elif r.direction == "NEGATIVE":
            assert r.lift < 0.0 and r.ci_high < 0.0
