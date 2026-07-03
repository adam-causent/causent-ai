"""Adversarial attack on C8 belief_direction (pure Status x Direction -> Belief map).

Strategy:
  1. Totality + stale-field traps: enumerate every Status x Direction and confirm
     C8 keys off (status, direction) ONLY, never a leaked lift/ci. Non-OK statuses
     must nuke any leftover direction to INCONCLUSIVE.
  2. Confidence-not-desirability: a *significant negative* is belief 1.0, not low.
     Proven end-to-end through C4 on planted data, with scipy.stats.t as an
     independent oracle for the CI/significance that drives the belief.
  3. Boundary: near-zero and exactly-zero planted effects — scipy decides the true
     significance; C8's belief must agree (1.0 iff CI excludes 0, else 0.5).
  4. Magnitude-invariance: belief is 1.0 for a barely-significant AND a massive
     effect alike (it is P(effect != 0), not |effect|).
  5. Purity: no input mutation, referential stability.
"""

import itertools
from dataclasses import replace

import numpy as np
import pytest
from scipy import stats

from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.types import Belief, ITSResult, PlaceboResult, Series
from hac_oracle import hac_cov

_BASE = 738000
_STATUSES = ["OK", "INSUFFICIENT", "DEGENERATE", "CONFOUNDED"]
_DIRECTIONS = ["POSITIVE", "NEGATIVE", "INCONCLUSIVE"]

# A placebo that did NOT fire — the readout survives falsification. The scipy oracle
# below models the ITS->belief map only, so we always feed it a non-firing placebo and
# test the placebo GATE separately.
_NO_FIRE = PlaceboResult("OK", 0.0, False)
_FIRED = PlaceboResult("OK", 42.0, True)


def _its(status, lift, direction, ci_low=None, ci_high=None):
    return ITSResult("ITS", status, lift, ci_low, ci_high, direction, 30, 30, 1.0, 1.0)


# ---------- scipy oracle for the whole ITS -> belief pipeline ----------

def _scipy_belief(series: Series) -> Belief:
    """Independently derive the belief C8 *should* produce, using scipy for the CI.

    Rebuilds the exact segmented design of C2, solves OLS, forms the 95% t-interval
    on the step coefficient with scipy.stats.t, then applies C8's documented map.
    """
    y = series.values.astype(np.float64)
    t = series.dates.astype(np.float64)
    n = y.size
    split = int(series.split)
    n_pre, n_post = split, n - split

    if n_pre < 14 or n_post < 14:
        return Belief(None, "INCONCLUSIVE")  # INSUFFICIENT

    post = np.arange(n) >= split
    cols = [np.ones(n), t - t.mean(), post.astype(np.float64)]
    if n_pre >= 28 and n_post >= 28:
        cols.append(np.where(post, t - t[split], 0.0))
    X = np.column_stack(cols)
    k = X.shape[1]

    coeffs, _, rank, s = np.linalg.lstsq(X, y, rcond=None)
    df = n - rank
    cond = s[0] / s[-1] if s[-1] > 0.0 else np.inf
    if rank < k or cond > 1e10 or df <= 0 or y.var() < 1e-10:
        return Belief(None, "INCONCLUSIVE", "DEGENERATE")  # DEGENERATE => UNKNOWN

    resid = y - X @ coeffs
    cov = hac_cov(X, resid)
    step = coeffs[2]
    half = stats.t.ppf(0.975, df) * np.sqrt(cov[2, 2])
    lo, hi = step - half, step + half

    if lo > 0.0:
        return Belief(1.0, "POSITIVE")
    if hi < 0.0:
        return Belief(1.0, "NEGATIVE")
    return Belief(0.5, "INCONCLUSIVE")


def _series(step, n_pre=40, n_post=40, noise=0.0, seed=0, slope=0.3):
    rng = np.random.default_rng(seed)
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + slope * np.arange(n_pre + n_post)
    if noise:
        vals = vals + rng.normal(0.0, noise, n_pre + n_post)
    vals[n_pre:] += step
    return Series(dates, vals, split=n_pre)


# ---------- 1. totality + stale-field traps (exhaustive) ----------

@pytest.mark.parametrize("status,direction", list(itertools.product(_STATUSES, _DIRECTIONS)))
def test_total_and_ignores_leaked_direction(status, direction):
    # Feed a hostile combo: a huge positive lift + significant-looking CI stapled
    # onto EVERY status/direction. Non-OK must ignore it; OK must honor direction.
    b = belief_direction(_its(status, 123.4, direction, ci_low=100.0, ci_high=146.0), _NO_FIRE)
    if status == "INSUFFICIENT":
        assert b == Belief(None, "INCONCLUSIVE")
    elif status == "DEGENERATE":
        assert b == Belief(None, "INCONCLUSIVE", "DEGENERATE")  # unusable => UNKNOWN
    elif status == "CONFOUNDED":
        assert b == Belief(0.0, "INCONCLUSIVE")  # genuine no-credible-effect
    elif direction == "INCONCLUSIVE":
        assert b == Belief(0.5, "INCONCLUSIVE")
    else:
        assert b == Belief(1.0, direction)  # 1.0 for POSITIVE *and* NEGATIVE


@pytest.mark.parametrize("status,direction", list(itertools.product(_STATUSES, _DIRECTIONS)))
def test_placebo_only_gates_an_ok_readout(status, direction):
    # A firing placebo falsifies an OK claim to 0.0/PLACEBO, but must not turn an
    # UNKNOWN (INSUFFICIENT/DEGENERATE) into a fabricated 0.0, nor touch CONFOUNDED.
    b = belief_direction(_its(status, 123.4, direction, ci_low=100.0, ci_high=146.0), _FIRED)
    if status == "OK":
        assert b == Belief(0.0, "INCONCLUSIVE", "PLACEBO")
    elif status == "INSUFFICIENT":
        assert b == Belief(None, "INCONCLUSIVE")
    elif status == "DEGENERATE":
        assert b == Belief(None, "INCONCLUSIVE", "DEGENERATE")
    else:
        assert b == Belief(0.0, "INCONCLUSIVE")  # CONFOUNDED unchanged


def test_belief_score_is_never_a_bare_zero_for_insufficient():
    # The None-vs-0.0 distinction is load-bearing (unknown != known-null effect).
    b = belief_direction(_its("INSUFFICIENT", None, "INCONCLUSIVE"), _NO_FIRE)
    assert b.belief_score is None
    assert b.belief_score is not False and b.belief_score != 0.0


# ---------- 2. confidence-not-desirability, scipy-verified ----------

@pytest.mark.parametrize("step,direction", [(8.0, "POSITIVE"), (-8.0, "NEGATIVE"), (-0.3, "NEGATIVE")])
def test_significant_effect_is_full_belief_matches_scipy(step, direction):
    series = _series(step, noise=0.05, seed=1)
    its = its_readout(series)
    oracle = _scipy_belief(series)
    got = belief_direction(its, _NO_FIRE)

    assert oracle == Belief(1.0, direction), f"scipy oracle disagrees: {oracle}"
    assert got == oracle  # C8 belief must equal the scipy-derived truth
    assert got.belief_score == 1.0  # a strong NEGATIVE is high belief, not low


def test_strong_negative_is_not_low_belief():
    # Direct assault on the "sign leaks into magnitude" bug class.
    its = its_readout(_series(-25.0, noise=0.1, seed=2))
    b = belief_direction(its, _NO_FIRE)
    assert its.direction == "NEGATIVE"
    assert b.belief_score == 1.0 and b.direction == "NEGATIVE"


# ---------- 3. boundary: scipy decides significance, C8 must agree ----------

@pytest.mark.parametrize("seed", range(12))
def test_noisy_zero_effect_agrees_with_scipy(seed):
    # True zero step under heavy noise: some seeds land CI-excludes-0 by chance,
    # some straddle. Whatever scipy says, C8 must produce the matching belief.
    series = _series(0.0, noise=2.0, seed=100 + seed)
    got = belief_direction(its_readout(series), _NO_FIRE)
    oracle = _scipy_belief(series)
    assert got == oracle, f"seed {seed}: C8={got} scipy={oracle}"


@pytest.mark.parametrize("seed", range(8))
def test_borderline_effect_agrees_with_scipy(seed):
    # Small effect near the detection threshold — the region where a flawed
    # significance mapping would flip 0.5<->1.0.
    series = _series(1.0, noise=3.0, seed=200 + seed, n_pre=30, n_post=30)
    got = belief_direction(its_readout(series), _NO_FIRE)
    oracle = _scipy_belief(series)
    assert got == oracle, f"seed {seed}: C8={got} scipy={oracle}"


# ---------- 4. magnitude invariance of the belief score ----------

def test_belief_is_indifferent_to_magnitude():
    tiny = belief_direction(_its("OK", 0.001, "POSITIVE", ci_low=0.0001, ci_high=0.0019), _NO_FIRE)
    huge = belief_direction(_its("OK", 1e9, "POSITIVE", ci_low=9e8, ci_high=1.1e9), _NO_FIRE)
    assert tiny.belief_score == huge.belief_score == 1.0


# ---------- 5. purity ----------

def test_no_input_mutation_and_stable():
    src = _its("OK", 4.0, "NEGATIVE", ci_low=-6.0, ci_high=-2.0)
    snapshot = replace(src)  # value copy of all fields
    b1 = belief_direction(src, _NO_FIRE)
    b2 = belief_direction(src, _NO_FIRE)
    assert b1 == b2 == Belief(1.0, "NEGATIVE")
    assert src == snapshot  # frozen dataclass untouched
