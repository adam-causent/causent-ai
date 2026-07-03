"""C8 — edge belief + direction from the authoritative ITS readout, placebo-gated.

Why: belief is a *projection* of the latest authoritative-method result, never a
stored mutation (decision-graph.md). This is the single place that turns C4's honest
verdict — falsified by C6's placebo-in-time — into the (belief_score, direction) an
edge renders, so the mapping can't drift.

Contract: belief_direction(its, placebo) -> Belief. Total over Status:
  INSUFFICIENT          -> None, INCONCLUSIVE             (<28 points; unknown, not zero)
  DEGENERATE            -> None, INCONCLUSIVE, 'DEGENERATE' (fit unusable => UNKNOWN)
  CONFOUNDED            -> 0.0,  INCONCLUSIVE             (cluster-confounded: no credible effect)
  OK & placebo.fired    -> 0.0,  INCONCLUSIVE, 'PLACEBO'  (method fabricates structure; unverified)
  OK & CI includes 0    -> 0.5,  INCONCLUSIVE
  OK & CI excludes 0    -> 1.0,  sign of lift (POSITIVE / NEGATIVE)

Placebo gate: a real readout is trustworthy only if the SAME method finds nothing
aimed at a fake pre-period intervention. A firing placebo means the fit is chasing
spurious structure, so the causal claim is unverified -> belief 0.0 / reason PLACEBO.
The gate only applies to an OK readout: there is no claim to falsify when the fit is
INSUFFICIENT (unknown) or DEGENERATE (unusable).

0.0 vs None is load-bearing: 0.0 = "no credible effect" (CONFOUNDED / falsified /
CI-straddles-nothing), None = "we don't know" (too little data, or an unusable fit).

Belief is confidence-that-effect≠0, not desirability: a significant NEGATIVE lift is
belief 1.0. Sign lives in direction; the CI test already lives in its.direction, so we
reuse it rather than re-deriving significance from ci_low/ci_high.
"""

from __future__ import annotations

from causal.types import Belief, ITSResult, PlaceboResult


def belief_direction(its: ITSResult, placebo: PlaceboResult) -> Belief:
    if its.status == "INSUFFICIENT":
        return Belief(None, "INCONCLUSIVE")           # unknown, NOT zero
    if its.status == "DEGENERATE":
        return Belief(None, "INCONCLUSIVE", "DEGENERATE")  # unusable fit => unknown
    if its.status == "CONFOUNDED":
        return Belief(0.0, "INCONCLUSIVE")            # genuine no-credible-effect
    # status == OK: a real estimate exists, so the placebo can falsify it.
    if placebo.fired:
        return Belief(0.0, "INCONCLUSIVE", "PLACEBO")  # falsified -> unverified
    if its.direction == "INCONCLUSIVE":               # OK but CI includes 0
        return Belief(0.5, "INCONCLUSIVE")
    return Belief(1.0, its.direction)                 # OK and CI excludes 0
