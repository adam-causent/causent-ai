"""Shared contracts for the causal engine. Every component consumes/produces these.

Kept deliberately small: primitives + typed results, no behavior. numpy-only.
See docs/designs/decision-graph.md for the belief/direction rules these encode.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

Direction = Literal["POSITIVE", "NEGATIVE", "INCONCLUSIVE"]
Method = Literal["ITS", "BEFORE_AFTER_14D", "MANUAL"]

# The one causal method, named honestly wherever it is shown. It is an Interrupted
# Time Series (segmented regression) with HAC SEs — NOT Google's CausalImpact
# (a Bayesian structural time-series method we do not implement).
ITS_METHOD_LABEL = "Interrupted Time Series (segmented regression)"

# Per-side day floor to FIT a readout at all: 14 pre + 14 post = the 28-point minimum.
# Single source of truth for C4 (its_readout), C5 (before_after_14d), C6 (placebo_in_time), C7 (power_mde).
MIN_SIDE = 14

# Per-side day floor to stake a CONFIDENT (belief 1.0) causal claim. Below it the
# readout is honestly "not yet evaluable, gathering data" (INSUFFICIENT_HISTORY) and
# belief is withheld (None). Tuned against the AR(1) coverage gate: at n < 45/side on
# autocorrelated daily data no SE correction keeps the false-positive rate honest, so
# we withhold rather than overclaim. See tests/test_autocorrelation_coverage.py.
FLOOR_CONFIDENT = 45

# Durbin-Watson floor for a confident belief. DW ~ 2(1 - rho1): DW below this means
# residual autocorrelation stronger than the small-sample HAC correction can be
# trusted to fix at this n, so belief is capped at 0.5 (reason AUTOCORRELATION). This
# is the "autocorrelation within what HAC can correct" gate — DW is consumed, not just
# stored. 1.3 corresponds to lag-1 residual autocorrelation ~0.35.
DW_CONFIDENT_MIN = 1.3

# Significance at which the placebo-in-time veto fires. Deliberately stricter than the
# readout's own 0.05: the placebo is a conservative falsification SCREEN on a short
# pre-period window, so it should only veto a confident belief on a strongly spurious
# pre-period step (the floor + DW cap carry the bulk of null control).
PLACEBO_ALPHA = 0.01

# One-line honest caveat the UI can surface next to any ITS readout.
ITS_CAVEAT = (
    f"{ITS_METHOD_LABEL}: observational, not a randomized test; assumes no other change "
    f"hit this metric at the same time (no co-temporal confounds); the confidence "
    f"interval is autocorrelation-adjusted (Newey-West HAC); a confident belief needs at "
    f"least {FLOOR_CONFIDENT} days of history on each side."
)

# Why a belief was withheld/downgraded, when it wasn't a plain OK projection.
# PLACEBO: a firing placebo-in-time falsified an otherwise-credible readout.
# AUTOCORRELATION: residual autocorrelation (low DW) beyond HAC's small-sample reach.
# INSUFFICIENT_HISTORY: fittable but below FLOOR_CONFIDENT — gathering data.
# DEGENERATE: the fit was unusable, so the effect is UNKNOWN (score None), not zero.
# FDR_DEMOTED: a per-action would-be 1.0 that failed Benjamini-Hochberg correction
#   across the metric's action family (batch_readout) — not significant after the
#   multiple-comparison control, so demoted to 0.5. Recorded (not NULL) so the
#   demotion is auditable and belief stays reproducible from the persisted edge.
BeliefReason = Literal[
    "PLACEBO", "AUTOCORRELATION", "INSUFFICIENT_HISTORY", "DEGENERATE", "FDR_DEMOTED"
]

# A readout status. INSUFFICIENT / INSUFFICIENT_HISTORY / DEGENERATE all render
# "inconclusive" but are distinct causes: INSUFFICIENT = too few points to fit at all
# (< MIN_SIDE/side); INSUFFICIENT_HISTORY = fittable but below FLOOR_CONFIDENT, so no
# confident claim yet; DEGENERATE = unusable fit; CONFOUNDED = cluster resolution.
Status = Literal[
    "OK", "INSUFFICIENT", "INSUFFICIENT_HISTORY", "DEGENERATE", "CONFOUNDED"
]


@dataclass(frozen=True)
class Series:
    """A daily metric series and the intervention point.

    dates: int64 ordinal days (sorted, unique). values: float64, same length.
    split: index of the first post-intervention observation (effective_date).
    """

    dates: np.ndarray
    values: np.ndarray
    split: int


@dataclass(frozen=True)
class Fit:
    """Output of segmented_ols (C2). Raw enough for the learning loop to reuse."""

    coeffs: np.ndarray        # [level, pre_slope, step, (post_slope?)]
    cov: np.ndarray           # Newey-West HAC covariance (autocorrelation-robust)
    resid_var: float
    cond_number: float
    n_pre: int
    n_post: int
    degenerate: bool          # rank-deficient / below variance floor
    durbin_watson: float = float("nan")  # residual autocorrelation diagnostic (~2 = none)
    hac_lag: int = 0          # Bartlett-kernel truncation lag used for the HAC cov


@dataclass(frozen=True)
class ITSResult:
    """Authoritative readout (C4)."""

    method: Method            # "ITS"
    status: Status
    lift: float | None        # step coefficient; None unless status == OK
    ci_low: float | None
    ci_high: float | None
    direction: Direction
    n_pre: int
    n_post: int
    resid_var: float | None
    cond_number: float | None
    p_value: float | None = None  # two-sided p for the step (HAC SE); None unless OK
    durbin_watson: float | None = None  # residual autocorrelation diagnostic, consumed by belief


@dataclass(frozen=True)
class BeforeAfterResult:
    """Descriptive cross-check (C5). Non-authoritative."""

    method: Method            # "BEFORE_AFTER_14D"
    status: Status
    lift: float | None        # post_mean - pre_mean
    ci_low: float | None
    ci_high: float | None


@dataclass(frozen=True)
class WindowStat:
    """One window of the always-on descriptive stat: mean(post) - mean(pre)."""

    window_days: int          # nominal window (7 or 14)
    n_pre: int                # points actually averaged on each side (<= window_days)
    n_post: int
    pre_mean: float | None
    post_mean: float | None
    lift: float | None        # post_mean - pre_mean; None if a side has no points


@dataclass(frozen=True)
class DescriptiveResult:
    """ALWAYS-ON, never-gated descriptive readout. DESCRIPTIVE, not causal: it carries
    NO belief and NO significance. This is what the user sees at every history length,
    including below FLOOR_CONFIDENT where the causal ITS withholds. Two windows so a
    fast 7-day read and a steadier 14-day read sit side by side."""

    kind: Literal["DESCRIPTIVE"]
    window_7d: WindowStat
    window_14d: WindowStat


@dataclass(frozen=True)
class PlaceboResult:
    """Pre-period falsification (C6). status == INSUFFICIENT => 'N/A, trust unverified'."""

    status: Status
    placebo_lift: float | None
    fired: bool               # True => real readout is suspect


@dataclass(frozen=True)
class PowerResult:
    """Detectability proxy (C7), computed pre-intervention."""

    mde: float | None         # minimum detectable effect (abs units)
    underpowered: bool        # mde exceeds the target-effect threshold


@dataclass(frozen=True)
class Belief:
    """Edge belief + direction (C8), derived from the authoritative ITS result
    gated by the placebo falsification (C6)."""

    belief_score: float | None
    direction: Direction
    reason: BeliefReason | None = None  # why belief was withheld/downgraded


@dataclass(frozen=True)
class ActionReadout:
    """One row of the batch response (C9): an action's results across methods."""

    action_ref: str
    its: ITSResult
    descriptive: DescriptiveResult   # always-on 7d + 14d mean-diff (shown even below the floor)
    before_after: BeforeAfterResult
    placebo: PlaceboResult
    belief: Belief


# Baseline-drift detector (C5/#18 — the demo's hero signal). Three outcomes:
# FIRED           a significant level shift sits in the pre-intervention window;
# NOT_FIRED       no shift big/credible enough (flat, noise, or below the floor);
# NO_BASELINE_YET the metric has no observations, or too few in-window points to
#                 fit any change-point ("gathering baseline" — NEVER a fire).
# A baseline move is a FACT, not a verdict: `direction` is the metric's movement,
# never a win/loss judgement (the notice renders it in neutral, not red/green).
DriftStatus = Literal["FIRED", "NOT_FIRED", "NO_BASELINE_YET"]


@dataclass(frozen=True)
class DriftResult:
    """Output of detect_baseline_drift (C5/#18). Computed on read, never persisted
    for the demo. Levels are the plainly-shown before/after segment means ("baseline
    moved 20% -> 12%"); the fire decision is driven by the segmented_ols step CI +
    a magnitude floor, so significance is rigorous while display stays legible.

    reason carries WHY, for the UI copy and audit:
      fired · no_significant_shift · below_floor · no_observations · gathering_baseline
    """

    status: DriftStatus
    shift_ordinal: int | None = None   # ordinal day of the detected change-point
    pre_level: float | None = None     # in-window pre-segment mean
    post_level: float | None = None    # in-window post-segment mean
    delta_native: float | None = None  # post_level - pre_level (native metric units)
    pct_change: float | None = None    # signed move relative to |pre_level|, in %
    direction: Literal["up", "down"] | None = None  # baseline movement (a fact)
    ci_low: float | None = None        # fitted step CI (native units)
    ci_high: float | None = None
    n_pre: int = 0                     # in-window points before the shift
    n_post: int = 0                    # in-window points on/after the shift
    reason: str | None = None
