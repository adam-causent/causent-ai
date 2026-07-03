"""C8 — edge belief + direction from the authoritative ITS readout, placebo-gated.

Why: belief is a *projection* of the latest authoritative-method result, never a
stored mutation (decision-graph.md). This is the single place that turns C4's honest
verdict — falsified by C6's placebo-in-time and capped by the data — into the
(belief_score, direction) an edge renders, so the mapping can't drift.

Contract: belief_direction(its, placebo) -> Belief. Total over Status:
  INSUFFICIENT          -> None, INCONCLUSIVE                        (<28 points; unknown)
  INSUFFICIENT_HISTORY  -> None, INCONCLUSIVE, 'INSUFFICIENT_HISTORY' (below the floor)
  DEGENERATE            -> None, INCONCLUSIVE, 'DEGENERATE'          (fit unusable => UNKNOWN)
  CONFOUNDED            -> 0.0,  INCONCLUSIVE                        (cluster-confounded)
  OK & placebo fired    -> 0.0,  INCONCLUSIVE, 'PLACEBO'            (method falsified)
  OK & CI includes 0    -> 0.5,  INCONCLUSIVE
  OK, CI excludes 0, but DW < DW_CONFIDENT_MIN    -> 0.5, INCONCLUSIVE, 'AUTOCORRELATION'
  OK, CI excludes 0, but placebo not evaluable    -> 0.5, INCONCLUSIVE
  OK, CI excludes 0, placebo clean, DW ok         -> 1.0, sign of lift (POSITIVE/NEGATIVE)

Belief 1.0 is only reachable when the readout cleared the FLOOR_CONFIDENT gate (that is
what turns a sub-floor fit into INSUFFICIENT_HISTORY upstream, so an OK result already
means n_pre, n_post >= FLOOR_CONFIDENT), the placebo did NOT fire, AND residual
autocorrelation is mild enough (Durbin-Watson >= DW_CONFIDENT_MIN) for the small-sample
HAC correction to be trusted. Strong autocorrelation (low DW) is beyond what HAC
reliably corrects at this n, so it caps belief at 0.5 rather than fabricating a 1.0 —
DW is consumed here, not merely displayed.

Placebo gate: a real readout is trustworthy only if the SAME method finds nothing aimed
at a fake pre-period intervention. A firing placebo means the fit is chasing spurious
structure -> belief 0.0 / reason PLACEBO. If the placebo could not be evaluated at all
(too little pre-history), the claim is unverified, so a confident 1.0 is withheld (0.5).

0.0 vs None is load-bearing: 0.0 = "no credible effect" (CONFOUNDED / placebo-falsified),
None = "we don't know" (too little data / below the floor / an unusable fit).
"""

from __future__ import annotations

from causal.types import DW_CONFIDENT_MIN, Belief, ITSResult, PlaceboResult


def belief_direction(its: ITSResult, placebo: PlaceboResult) -> Belief:
    if its.status == "INSUFFICIENT":
        return Belief(None, "INCONCLUSIVE")                      # unknown, NOT zero
    if its.status == "INSUFFICIENT_HISTORY":
        return Belief(None, "INCONCLUSIVE", "INSUFFICIENT_HISTORY")  # gathering data
    if its.status == "DEGENERATE":
        return Belief(None, "INCONCLUSIVE", "DEGENERATE")        # unusable fit => unknown
    if its.status == "CONFOUNDED":
        return Belief(0.0, "INCONCLUSIVE")                       # genuine no-credible-effect

    # status == OK: a real, above-floor estimate exists.
    if placebo.fired:                                           # method fabricates structure
        return Belief(0.0, "INCONCLUSIVE", "PLACEBO")           # falsified -> no credible effect
    if its.direction == "INCONCLUSIVE":                         # CI includes 0
        return Belief(0.5, "INCONCLUSIVE")
    # CI excludes 0 and the placebo did not fire: a candidate 1.0, subject to the
    # remaining data-quality guards.
    if its.durbin_watson is None or its.durbin_watson < DW_CONFIDENT_MIN:
        return Belief(0.5, "INCONCLUSIVE", "AUTOCORRELATION")    # too autocorrelated to trust
    if placebo.status != "OK":
        return Belief(0.5, "INCONCLUSIVE")                       # unverifiable -> withhold 1.0
    return Belief(1.0, its.direction)                           # survived every guard
