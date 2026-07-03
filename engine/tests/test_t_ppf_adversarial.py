"""Adversarial tests for C1 t_ppf — written by a reviewer who did NOT author it.

Goal: try to BREAK the pure-numpy Student-t quantile. Oracle is scipy.stats.t.ppf
(allowed in tests ONLY; the shipped engine never imports scipy). We attack the
mandated grid to the 1e-6 target, then hammer symmetry, monotonicity, extremes,
and degenerate/boundary inputs.

Conclusion encoded below: on the mandated grid the pure-numpy impl matches scipy
to ~1e-10 (10,000x under the 1e-6 target) — so the "Python-vs-TS T0" question is
settled: pure numpy easily reaches 1e-6. The only divergences we could produce
are far outside the operating envelope (fractional df<1, df=inf, or p within
~1e-10 of {0,1}); those are documented as known limits, not regressions, because
the engine only ever feeds integer df>=1 and p in [0.005, 0.995].
"""

import math

import numpy as np
import pytest
from scipy import stats

from causal.t_ppf import t_ppf


# --------------------------------------------------------------------------
# 1. The mandated oracle grid — the load-bearing deliverable. Target abs<1e-6.
# --------------------------------------------------------------------------
GRID_DF = [1.0, 2.0, 5.0, 10.0, 30.0, 100.0, 1e6]
GRID_P = [0.005, 0.025, 0.5, 0.975, 0.995]


@pytest.mark.parametrize("df", GRID_DF)
@pytest.mark.parametrize("p", GRID_P)
def test_mandated_grid_abs_err_under_1e6(p, df):
    got = t_ppf(p, df)
    oracle = float(stats.t.ppf(p, df))
    assert abs(got - oracle) < 1e-6, f"df={df} p={p}: {got} vs {oracle}"


def test_mandated_grid_actually_hits_1e9():
    """Tighter than asked: the whole grid is under 1e-9 abs. This is the T0 answer."""
    worst = 0.0
    for df in GRID_DF:
        for p in GRID_P:
            worst = max(worst, abs(t_ppf(p, df) - float(stats.t.ppf(p, df))))
    assert worst < 1e-9, f"worst grid abs err {worst:g} exceeded 1e-9"


# --------------------------------------------------------------------------
# 2. Wide oracle match across the realistic operating envelope.
#    Integer df>=1, p from 1e-4 to 1-1e-4 (well beyond any real confidence level).
# --------------------------------------------------------------------------
@pytest.mark.parametrize("df", [1, 2, 3, 4, 5, 7, 10, 15, 30, 60, 100, 500, 1000])
@pytest.mark.parametrize(
    "p",
    [1e-4, 1e-3, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.4,
     0.6, 0.75, 0.9, 0.95, 0.975, 0.99, 0.995, 0.999, 1 - 1e-4],
)
def test_wide_envelope_matches_scipy(df, p):
    got = t_ppf(p, float(df))
    oracle = float(stats.t.ppf(p, df))
    # abs OR rel — deep tails have huge magnitude where abs is meaningless.
    assert got == pytest.approx(oracle, abs=1e-8, rel=1e-9), f"df={df} p={p}"


def test_deep_tail_integer_df_stays_accurate():
    """Attack the tails: even p=1e-8 with integer df stays under 1e-6 rel error."""
    worst = 0.0
    for df in [1, 2, 5, 10, 30, 100]:
        for p in [1e-5, 1e-6, 1e-7, 1e-8]:
            got = t_ppf(p, float(df))
            oracle = float(stats.t.ppf(p, df))
            worst = max(worst, abs(got - oracle) / abs(oracle))
    assert worst < 1e-6, f"deep-tail rel err {worst:g}"


# --------------------------------------------------------------------------
# 3. Closed-form oracles independent of scipy.
# --------------------------------------------------------------------------
def test_cauchy_closed_form_wide():
    # df=1 is Cauchy: quantile = tan(pi*(p-0.5)). Attack near-median and tails.
    for p in [1e-4, 1e-3, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999]:
        assert t_ppf(p, 1.0) == pytest.approx(math.tan(math.pi * (p - 0.5)), rel=1e-8, abs=1e-9)


def test_normal_limit_large_df():
    # df -> inf collapses to the standard normal quantile.
    for p in [0.005, 0.025, 0.5, 0.975, 0.995]:
        assert t_ppf(p, 1e6) == pytest.approx(float(stats.norm.ppf(p)), abs=1e-4)
        assert t_ppf(p, 1e9) == pytest.approx(float(stats.norm.ppf(p)), abs=1e-6)


# --------------------------------------------------------------------------
# 4. Symmetry / antisymmetry — the explicit contract t_ppf(p)=-t_ppf(1-p).
# --------------------------------------------------------------------------
@pytest.mark.parametrize("df", [1.0, 2.0, 5.0, 10.0, 30.0, 100.0, 1e6])
@pytest.mark.parametrize("p", [1e-5, 1e-4, 0.005, 0.025, 0.1, 0.3, 0.49])
def test_antisymmetry_operating_envelope(p, df):
    assert t_ppf(p, df) == pytest.approx(-t_ppf(1.0 - p, df), rel=1e-9, abs=1e-12)


def test_median_exactly_zero():
    for df in [0.5, 1.0, 2.0, 7.5, 50.0, 1e6]:
        assert t_ppf(0.5, df) == 0.0


# --------------------------------------------------------------------------
# 5. Strict monotonicity in p across the operating envelope.
# --------------------------------------------------------------------------
@pytest.mark.parametrize("df", [1.0, 2.0, 5.0, 10.0, 30.0, 100.0, 1000.0])
def test_strict_monotonic_in_p(df):
    ps = np.concatenate([
        np.logspace(-8, -2, 200),
        np.linspace(0.01, 0.99, 400),
        1 - np.logspace(-2, -8, 200),
    ])
    ps = np.unique(ps)
    vals = [t_ppf(float(p), df) for p in ps]
    assert all(b > a for a, b in zip(vals, vals[1:])), f"non-monotone at df={df}"


def test_monotonic_in_df_at_fixed_upper_tail():
    # For p>0.5 the t-critical value decreases as df grows (fatter tails shrink).
    p = 0.975
    vals = [t_ppf(p, df) for df in [1, 2, 5, 10, 30, 100, 1000, 1e6]]
    assert all(b < a for a, b in zip(vals, vals[1:]))
    assert vals[-1] == pytest.approx(float(stats.norm.ppf(p)), abs=1e-5)


# --------------------------------------------------------------------------
# 6. Extremes and boundaries.
# --------------------------------------------------------------------------
def test_p_zero_and_one_are_infinite():
    assert t_ppf(0.0, 5.0) == float("-inf")
    assert t_ppf(1.0, 5.0) == float("inf")
    assert t_ppf(0, 5.0) == float("-inf")   # int 0
    assert t_ppf(1, 5.0) == float("inf")    # int 1


def test_no_crash_on_extreme_but_valid_p():
    # Subnormal and just-below-one probabilities must return finite ordered values.
    lo = t_ppf(5e-324, 5.0)   # smallest positive double
    hi = t_ppf(1 - 1e-16, 5.0)
    assert math.isfinite(lo) and math.isfinite(hi)
    assert lo < 0 < hi


# --------------------------------------------------------------------------
# 7. Degenerate inputs must raise, never fabricate.
# --------------------------------------------------------------------------
@pytest.mark.parametrize("df", [0.0, -1.0, -1e-9, float("nan")])
def test_invalid_df_raises(df):
    with pytest.raises(ValueError):
        t_ppf(0.5, df)


@pytest.mark.parametrize("p", [-0.1, -1e-9, 1.1, 1.0 + 1e-9, float("nan")])
def test_invalid_p_raises(p):
    with pytest.raises(ValueError):
        t_ppf(p, 5.0)


def test_integer_df_accepted():
    # df passed as a Python int (n-k is integer arithmetic upstream) must work.
    assert t_ppf(0.975, 10) == pytest.approx(2.2281388519862735, abs=1e-9)


# --------------------------------------------------------------------------
# 8. DOCUMENTED LIMITS — inputs outside the operating envelope. These pin the
#    known-divergence behavior so it can't silently change; they are NOT
#    correctness claims. The engine never produces these inputs (df is an integer
#    >=1 from OLS residual df; p is a confidence level in [0.005, 0.995]).
# --------------------------------------------------------------------------
def test_known_limit_df_infinity_returns_nan_not_normal():
    """df=inf slips past the `df>0` guard and yields nan instead of the normal
    quantile scipy gives. Silent nan, but df=inf is never fed by the engine."""
    assert math.isnan(t_ppf(0.975, float("inf")))
    assert float(stats.t.ppf(0.975, float("inf"))) == pytest.approx(1.959963984540054)


def test_known_limit_fractional_df_below_one_diverges():
    """df<1 (never emitted by integer OLS df) loses accuracy in the tail."""
    got = t_ppf(0.975, 1e-6)
    oracle = float(stats.t.ppf(0.975, 1e-6))
    # These disagree by many orders of magnitude — documented, out of envelope.
    assert abs(got - oracle) / abs(oracle) > 0.5


def test_known_limit_ultra_deep_tail_loses_precision():
    """p within ~1e-12 of the boundary degrades (float resolution of the tail).
    Real confidence levels never approach this; documented for completeness."""
    p = 1e-13
    got = t_ppf(p, 1.0)
    oracle = float(stats.t.ppf(p, 1.0))
    # Still finite, still correct sign & rough magnitude, but not 1e-6 accurate.
    assert math.isfinite(got) and got < 0
    assert 0.5 < got / oracle < 2.0  # same order of magnitude, not tight
