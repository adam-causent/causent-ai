"""OBJECTIVE gate for the honest small-sample redesign — Monte-Carlo coverage.

Serially correlated daily metrics make iid OLS standard errors too small, so the ITS
step CI is too narrow and fires on structure that isn't there. No SE formula alone
fixes this at the n=28-90/side regime the product operates in; the honest fix is a
DESIGN: (1) a per-side data floor (FLOOR_CONFIDENT) below which belief is WITHHELD
(None) — "not yet evaluable, gathering data"; (2) a small-sample HAC dof correction on
the covariance; (3) a Durbin-Watson belief cap that refuses a confident 1.0 when
residual autocorrelation is beyond what HAC can correct; (4) a placebo-in-time veto
that actually fires in-regime. This file is the gate that design must pass.

The draws mimic the real product: per-side history is drawn uniformly in [10, 180]
days and AR(1) autocorrelation rho uniformly in [0, 0.8]. On a NULL (no true step) the
gate asserts, on the SAME draws:
  (a) OVERALL, the fraction of ALL readouts that emit belief_score == 1.0 is <= 0.06.
      Withholding below the floor (belief None) is the honest way this stays low.
  (b) CONDITIONAL, among readouts that emitted a real belief score (not None, i.e. at
      or above the floor), the false-positive rate (belief == 1.0) is <= 0.08.
Plus a POWER check: a real large step WITH adequate history (both sides >= the floor)
must still fire belief 1.0 the large majority of the time — the guards must curb false
positives without killing genuine detection.

These ceilings are the honesty contract and must not be weakened; the floor and the
correction mechanism are what get tuned. numpy-only; fully seeded so rates reproduce.
"""

import numpy as np
import pytest

from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import FLOOR_CONFIDENT, Series

_BASE = 738000        # arbitrary ordinal-day offset; centering absorbs it
_SIGMA = 2.0          # innovation scale of the AR(1) residual
_DRAWS = 8000         # nulls; MC SE at p=0.03 is ~0.002
_N_LO, _N_HI = 10, 181  # per-side history drawn uniformly in [10, 180] days
_RHO_HI = 0.8         # AR(1) coefficient drawn uniformly in [0, 0.8]

# Coverage gate — the honesty contract. DO NOT weaken these.
_OVERALL_CEILING = 0.06     # fraction of ALL null readouts emitting belief 1.0
_CONDITIONAL_CEILING = 0.08  # false-positive rate among evaluable (non-None) readouts
_POWER_FLOOR = 0.90         # belief 1.0 rate on a real large step with adequate history


def _ar1_noise(n: int, rho: float, rng: np.random.Generator) -> np.ndarray:
    """AR(1) residual e_i = innovation_i + rho * e_{i-1} (rho=0 => iid)."""
    e = rng.normal(0.0, _SIGMA, n)
    for i in range(1, n):
        e[i] += rho * e[i - 1]
    return e


def _null_series(n_pre: int, n_post: int, rho: float, rng: np.random.Generator) -> Series:
    """A daily series with NO true step: constant level + AR(1) residual."""
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    y = 1.0 + _ar1_noise(n, rho, rng)   # level only; step == 0 by construction
    return Series(dates=dates, values=y, split=n_pre)


def _belief_score(series: Series) -> float | None:
    """The end-to-end belief a null readout would emit (ITS + placebo, projected)."""
    its = its_readout(series)
    placebo = placebo_in_time(series, its)
    return belief_direction(its, placebo).belief_score


def _null_rates(draws: int = _DRAWS, seed: int = 0) -> tuple[float, float, int]:
    """(overall belief-1.0 rate, conditional FP rate, #evaluable) over `draws` nulls."""
    rng = np.random.default_rng(seed)
    belief_one = 0
    evaluable = 0
    for _ in range(draws):
        n_pre = int(rng.integers(_N_LO, _N_HI))
        n_post = int(rng.integers(_N_LO, _N_HI))
        rho = float(rng.uniform(0.0, _RHO_HI))
        score = _belief_score(_null_series(n_pre, n_post, rho, rng))
        if score is not None:            # at/above the floor => a real belief was emitted
            evaluable += 1
        if score == 1.0:
            belief_one += 1
    overall = belief_one / draws
    conditional = belief_one / evaluable if evaluable else 0.0
    return overall, conditional, evaluable


# ---------- claim (a): overall confident-belief rate on the null is rare ----------

def test_overall_confident_belief_rate_within_gate():
    overall, _, _ = _null_rates()
    assert overall <= _OVERALL_CEILING, (
        f"overall belief_score==1.0 rate {overall:.4f} exceeds the {_OVERALL_CEILING} "
        f"gate over {_DRAWS} NULL AR(1) draws: the engine stakes confident causal "
        f"claims on pure noise too often — raise the floor or strengthen the correction."
    )


# ---------- claim (b): among evaluable readouts, the null FP rate holds ----------

def test_conditional_false_positive_rate_within_gate():
    _, conditional, evaluable = _null_rates()
    assert conditional <= _CONDITIONAL_CEILING, (
        f"conditional (above-floor) false-positive rate {conditional:.4f} over "
        f"{evaluable} evaluable readouts exceeds the {_CONDITIONAL_CEILING} gate: the "
        f"small-sample HAC + Durbin-Watson cap do not hold coverage at the floor."
    )


# ---------- power: the guards must not kill real detection ----------

def test_power_belief_fires_on_true_large_step_with_history():
    draws = 4000
    step = 8.0  # ~4 sigma level shift; unmistakable
    rng = np.random.default_rng(0xBEEF)
    hits = 0
    for _ in range(draws):
        # "adequate history": both sides at or above the confident floor.
        n_pre = int(rng.integers(FLOOR_CONFIDENT, _N_HI))
        n_post = int(rng.integers(FLOOR_CONFIDENT, _N_HI))
        n = n_pre + n_post
        y = 1.0 + _ar1_noise(n, 0.0, rng)
        y[n_pre:] += step
        s = Series(_BASE + np.arange(n), y, n_pre)
        if _belief_score(s) == 1.0:
            hits += 1
    power = hits / draws
    assert power >= _POWER_FLOOR, (
        f"power {power:.4f} below {_POWER_FLOOR}: the honesty guards have suppressed "
        f"detection of a real {step}-unit step with adequate history ({draws} trials)."
    )
