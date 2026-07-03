"""Golden-data + adversarial tests for C8 belief_direction.

Truth: on noise-free data C4 recovers a KNOWN planted step, so its verdict is
determined and the belief mapping has a KNOWN answer — a real +8 step ships belief
1.0/POSITIVE, a real -8 step ships 1.0/NEGATIVE (belief is confidence-that-effect≠0,
so a significant negative is high belief). The rest of the contract is a total map
over Status × direction, checked exhaustively including the CI-includes-zero boundary
and the two "stale field" traps (belief must read status/direction, never lift).
"""

import numpy as np
import pytest

from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.types import Belief, ITSResult, PlaceboResult, Series

_BASE = 738000  # arbitrary ordinal-day offset; centering absorbs it

# Belief now depends on the placebo falsification too. Most cases feed a placebo that
# did NOT fire (the readout survives falsification); a couple feed a firing one to
# prove the gate. INSUFFICIENT (N/A) and a clean OK placebo both have fired=False.
_NO_FIRE = PlaceboResult("OK", 0.0, False)
_FIRED = PlaceboResult("OK", 9.9, True)


def _its(status, lift, direction, ci_low=None, ci_high=None):
    """Construct an ITSResult for the branches C4 can't be coaxed to emit cleanly."""
    return ITSResult("ITS", status, lift, ci_low, ci_high, direction, 30, 30, 1.0, 1.0)


# ---------- golden: KNOWN truth recovered by C4, then mapped ----------

@pytest.mark.parametrize("step,direction", [(8.0, "POSITIVE"), (-8.0, "NEGATIVE")])
def test_significant_step_is_full_belief(step, direction):
    n_pre, n_post = 40, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post)
    vals[n_pre:] += step  # noise-free -> tight CI that excludes 0
    its = its_readout(Series(dates, vals, split=n_pre))
    assert its.status == "OK" and its.direction == direction  # C4 recovered the truth

    b = belief_direction(its, _NO_FIRE)
    assert b.belief_score == 1.0
    assert b.direction == direction


def test_zero_effect_with_noise_is_half_belief():
    # A true zero step under noise: C4 stays OK but its CI includes 0 -> 0.5.
    rng = np.random.default_rng(7)
    n_pre, n_post = 40, 40
    dates = _BASE + np.arange(n_pre + n_post)
    vals = 5.0 + 0.3 * np.arange(n_pre + n_post) + rng.normal(0.0, 1.0, n_pre + n_post)
    its = its_readout(Series(dates, vals, split=n_pre))
    assert its.status == "OK" and its.direction == "INCONCLUSIVE"  # CI straddles 0

    b = belief_direction(its, _NO_FIRE)
    assert b.belief_score == 0.5
    assert b.direction == "INCONCLUSIVE"


# ---------- degenerate / insufficient status branches ----------

def test_insufficient_is_null_belief():
    b = belief_direction(_its("INSUFFICIENT", None, "INCONCLUSIVE"), _NO_FIRE)
    assert b.belief_score is None  # unknown, NOT zero
    assert b.direction == "INCONCLUSIVE"
    assert b.reason is None


def test_degenerate_is_null_unknown_not_zero():
    # DEGENERATE = unusable fit => UNKNOWN (None), NOT "no effect" (0.0). 0.0 is
    # reserved for CONFOUNDED / genuine no-credible-effect. Reason marks the cause.
    b = belief_direction(_its("DEGENERATE", None, "INCONCLUSIVE"), _NO_FIRE)
    assert b.belief_score is None
    assert b.direction == "INCONCLUSIVE"
    assert b.reason == "DEGENERATE"


def test_confounded_is_zero_belief():
    b = belief_direction(_its("CONFOUNDED", None, "INCONCLUSIVE"), _NO_FIRE)
    assert b.belief_score == 0.0
    assert b.direction == "INCONCLUSIVE"
    assert b.reason is None


# ---------- placebo gate: a firing placebo falsifies an otherwise-credible OK ----------

def test_placebo_fired_flips_significant_belief_to_zero():
    # A textbook OK/POSITIVE readout (would be 1.0) is falsified by the placebo:
    # belief drops to 0.0 with reason PLACEBO, direction nuked to INCONCLUSIVE.
    its = _its("OK", 8.0, "POSITIVE", ci_low=6.0, ci_high=10.0)
    survived = belief_direction(its, _NO_FIRE)
    falsified = belief_direction(its, _FIRED)
    assert survived == Belief(1.0, "POSITIVE")           # placebo clean -> full belief
    assert falsified == Belief(0.0, "INCONCLUSIVE", "PLACEBO")  # SAME its, flipped


def test_placebo_does_not_resurrect_insufficient_or_degenerate():
    # No claim to falsify when the fit is unusable/insufficient: the placebo gate is
    # skipped, so belief stays UNKNOWN (None), never forced to 0.0 by a firing placebo.
    assert belief_direction(_its("INSUFFICIENT", None, "INCONCLUSIVE"), _FIRED) \
        == Belief(None, "INCONCLUSIVE")
    assert belief_direction(_its("DEGENERATE", None, "INCONCLUSIVE"), _FIRED) \
        == Belief(None, "INCONCLUSIVE", "DEGENERATE")


# ---------- boundary: CI touching zero is inconclusive, not significant ----------

def test_ci_touching_zero_is_half_belief():
    # ci_low == 0 exactly => C4 emits direction INCONCLUSIVE => 0.5, never 1.0.
    b = belief_direction(_its("OK", 3.0, "INCONCLUSIVE", ci_low=0.0, ci_high=6.0), _NO_FIRE)
    assert b.belief_score == 0.5
    assert b.direction == "INCONCLUSIVE"


# ---------- adversarial: mapping keys off status/direction, never a stale lift ----------

def test_inconclusive_ok_ignores_positive_lift():
    # A positive point estimate whose CI includes 0 must NOT leak a POSITIVE edge.
    b = belief_direction(_its("OK", 4.2, "INCONCLUSIVE", ci_low=-1.0, ci_high=9.4), _NO_FIRE)
    assert b.belief_score == 0.5
    assert b.direction == "INCONCLUSIVE"


def test_degenerate_ignores_leftover_lift():
    # Even if a lift/direction leaked onto a DEGENERATE result, belief is None/INCONCLUSIVE.
    b = belief_direction(_its("DEGENERATE", 99.0, "POSITIVE", ci_low=50.0, ci_high=150.0), _NO_FIRE)
    assert b.belief_score is None
    assert b.direction == "INCONCLUSIVE"
    assert b.reason == "DEGENERATE"


def test_total_over_every_status():
    # Totality: every Status maps to a defined belief; no crash, no undefined score.
    expected = {
        "INSUFFICIENT": Belief(None, "INCONCLUSIVE"),
        "DEGENERATE": Belief(None, "INCONCLUSIVE", "DEGENERATE"),
        "CONFOUNDED": Belief(0.0, "INCONCLUSIVE"),
    }
    for status, want in expected.items():
        assert belief_direction(_its(status, None, "INCONCLUSIVE"), _NO_FIRE) == want
