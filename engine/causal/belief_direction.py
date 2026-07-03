"""C8 — edge belief + direction from the authoritative ITS readout, pure mapping.

Why: belief is a *projection* of the latest authoritative-method result, never a
stored mutation (decision-graph.md). This is the single place that turns C4's honest
verdict into the (belief_score, direction) an edge renders, so the mapping can't drift.

Contract: belief_direction(its) -> Belief. Total over Status:
  OK  & CI excludes 0 -> 1.0, sign of lift (its.direction is POSITIVE/NEGATIVE)
  OK  & CI includes 0 -> 0.5, INCONCLUSIVE
  DEGENERATE/CONFOUNDED -> 0.0, INCONCLUSIVE   (fit unusable / cluster-confounded)
  INSUFFICIENT          -> None, INCONCLUSIVE  (<28 points; unknown, not zero)

Belief is confidence-that-effect≠0, not desirability: a significant NEGATIVE lift is
belief 1.0. Sign lives in direction; the CI test already lives in its.direction, so we
reuse it rather than re-deriving significance from ci_low/ci_high.
"""

from __future__ import annotations

from causal.types import Belief, ITSResult


def belief_direction(its: ITSResult) -> Belief:
    if its.status == "INSUFFICIENT":
        return Belief(None, "INCONCLUSIVE")
    if its.status != "OK":  # DEGENERATE or CONFOUNDED
        return Belief(0.0, "INCONCLUSIVE")
    if its.direction == "INCONCLUSIVE":  # OK but CI includes 0
        return Belief(0.5, "INCONCLUSIVE")
    return Belief(1.0, its.direction)  # OK and CI excludes 0
