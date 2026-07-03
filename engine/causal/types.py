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

# A readout status. INSUFFICIENT and DEGENERATE both render "inconclusive" but are
# distinct causes; CONFOUNDED comes from cluster resolution upstream.
Status = Literal["OK", "INSUFFICIENT", "DEGENERATE", "CONFOUNDED"]


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
    cov: np.ndarray           # coefficient covariance matrix
    resid_var: float
    cond_number: float
    n_pre: int
    n_post: int
    degenerate: bool          # rank-deficient / below variance floor


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


@dataclass(frozen=True)
class BeforeAfterResult:
    """Descriptive cross-check (C5). Non-authoritative."""

    method: Method            # "BEFORE_AFTER_14D"
    status: Status
    lift: float | None        # post_mean - pre_mean
    ci_low: float | None
    ci_high: float | None


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
    """Edge belief + direction (C8), derived from the authoritative ITS result."""

    belief_score: float | None
    direction: Direction


@dataclass(frozen=True)
class ActionReadout:
    """One row of the batch response (C9): an action's results across methods."""

    action_ref: str
    its: ITSResult
    before_after: BeforeAfterResult
    placebo: PlaceboResult
    belief: Belief
