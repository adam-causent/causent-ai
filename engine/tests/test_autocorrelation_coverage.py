"""OBJECTIVE gate for the autocorrelation fix (HAC) — Monte-Carlo coverage.

Serially correlated daily metrics make iid OLS standard errors too small, so the
ITS step CI is too narrow and fires on structure that isn't there. The fix is the
Newey-West HAC covariance in segmented_ols (C2), consumed by step_ci (C3) and
its_readout (C4). This file is the gate that fix must pass: under a NULL (no true
step) with AR(1) residuals, the readout's false-positive rate — the fraction whose
95% CI excludes zero, i.e. the fraction that would emit belief 1.0 — must sit at or
below the nominal 5% plus a Monte-Carlo margin (<= ~0.08) at every autocorrelation
level, not just under white noise.

Pre-fix reference (iid SEs) blew past that: ~0.24 at rho=0.5 and ~0.50 at rho=0.8.
HAC has to buy that rate back down. This test does NOT assume the fix is adequate —
if the observed FP rate exceeds the gate, the assertion fails and prints the measured
rate, which is the signal that HAC as implemented is insufficient (do not weaken it).

Two claims are checked on the SAME nulls:
  1. its_readout FP rate (CI excludes 0) <= 0.08 at rho in {0.0, 0.5, 0.8}.
  2. belief_direction (placebo-gated) emits belief_score == 1.0 <= 0.06 at rho=0.8.
Plus a POWER sanity check: on a real large step with low autocorrelation, belief 1.0
must still fire most of the time — the fix must curb false positives without killing
genuine detection.

numpy-only; the engine ships numpy-only. Fully seeded so the reported rates reproduce.
"""

import numpy as np
import pytest

from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import Series

_BASE = 738000        # arbitrary ordinal-day offset; centering absorbs it
_SIGMA = 2.0          # innovation scale of the AR(1) residual
_DRAWS = 5000         # trials per rho; MC SE at p=0.05 is ~0.003
_N_LO, _N_HI = 28, 61  # series length drawn uniformly in [28, 60] (mid split)

# Coverage gate. Nominal alpha is 0.05; the ceilings add a Monte-Carlo margin.
_FP_CEILING = 0.08          # its_readout CI-excludes-zero rate, every rho
_BELIEF_CEILING = 0.06      # placebo-gated belief==1.0 rate at rho=0.8
_POWER_FLOOR = 0.90         # belief==1.0 rate on a real large step, rho=0

_RHOS = (0.0, 0.5, 0.8)


def _ar1_noise(n: int, rho: float, rng: np.random.Generator) -> np.ndarray:
    """AR(1) residual e_i = innovation_i + rho * e_{i-1} (rho=0 => iid).

    Same recursion the engine's own oracle uses (test_its_readout._make), so the
    autocorrelation model here matches how C2/C4 are exercised elsewhere.
    """
    e = rng.normal(0.0, _SIGMA, n)
    for i in range(1, n):
        e[i] += rho * e[i - 1]
    return e


def _null_series(n: int, rho: float, rng: np.random.Generator) -> Series:
    """A daily series with NO true step: constant level + AR(1) residual."""
    dates = _BASE + np.arange(n)
    y = 1.0 + _ar1_noise(n, rho, rng)   # level only; step == 0 by construction
    return Series(dates=dates, values=y, split=n // 2)


def _step_series(n: int, step: float, rng: np.random.Generator) -> Series:
    """A daily series WITH a true level shift `step`, low autocorrelation (iid)."""
    dates = _BASE + np.arange(n)
    split = n // 2
    y = 1.0 + _ar1_noise(n, 0.0, rng)
    y[split:] += step
    return Series(dates=dates, values=y, split=split)


def _null_rates(rho: float, draws: int = _DRAWS) -> tuple[float, float]:
    """(false-positive rate, placebo-gated belief==1.0 rate) over `draws` nulls.

    FP = its_readout status OK and CI excludes 0 (direction != INCONCLUSIVE).
    belief rate = belief_direction(its, placebo) yields belief_score == 1.0.
    """
    rng = np.random.default_rng(0xC0FFEE ^ int(round(rho * 1000)))
    fp = 0
    belief_one = 0
    for _ in range(draws):
        n = int(rng.integers(_N_LO, _N_HI))
        s = _null_series(n, rho, rng)
        r = its_readout(s)
        if r.status == "OK" and r.direction != "INCONCLUSIVE":
            fp += 1
        placebo = placebo_in_time(s, r)
        if belief_direction(r, placebo).belief_score == 1.0:
            belief_one += 1
    return fp / draws, belief_one / draws


# ---------- claim 1: HAC holds the null FP rate at/below the gate, every rho ----------

@pytest.mark.parametrize("rho", _RHOS)
def test_null_false_positive_rate_within_gate(rho):
    fp_rate, _ = _null_rates(rho)
    assert fp_rate <= _FP_CEILING, (
        f"NULL false-positive rate {fp_rate:.4f} exceeds the {_FP_CEILING} gate at "
        f"rho={rho} ({_DRAWS} trials): the autocorrelation fix is insufficient — "
        f"HAC did not bring CI coverage back to the nominal 5%."
    )


# ---------- claim 2: placebo-gated belief 1.0 stays rare on strong autocorrelation ----------

def test_placebo_gated_belief_rate_within_gate_high_rho():
    _, belief_rate = _null_rates(0.8)
    assert belief_rate <= _BELIEF_CEILING, (
        f"placebo-gated belief_score==1.0 rate {belief_rate:.4f} exceeds the "
        f"{_BELIEF_CEILING} gate at rho=0.8 ({_DRAWS} trials): spurious 'shipped and "
        f"worked' beliefs still leak through on pure autocorrelation."
    )


# ---------- power: the fix must not kill real detection ----------

def test_power_belief_fires_on_true_large_step():
    draws = 2000
    step = 6.0  # ~3 sigma level shift; unmistakable at low autocorrelation
    rng = np.random.default_rng(0xBEEF)
    hits = 0
    for _ in range(draws):
        n = int(rng.integers(_N_LO, _N_HI))
        s = _step_series(n, step, rng)
        r = its_readout(s)
        placebo = placebo_in_time(s, r)
        if belief_direction(r, placebo).belief_score == 1.0:
            hits += 1
    power = hits / draws
    assert power >= _POWER_FLOOR, (
        f"power {power:.4f} below {_POWER_FLOOR}: the autocorrelation fix has "
        f"suppressed detection of a real {step}-unit step ({draws} trials)."
    )
