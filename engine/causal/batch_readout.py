"""C9 — batch readout for one metric across many actions, pure numpy.

Why: the pipeline runs ONE engine call per metric and gets back one row per action
(decision-graph.md, step 3). Each action shares the metric's daily series but has its
own intervention point (its effective_date -> `split`). This fans that shared series
out into a per-action ITS readout, its descriptive cross-check, its placebo check, and
the belief projection — the exact ActionReadout rows the edge/evidence writer consumes.

Contract: batch_readout(series, action_splits, max_actions=200, q=0.05)
  -> list[ActionReadout], one per (action_ref, split), in input order. For each action
  we build the per-action view Series(series.dates, series.values, split) and run C4
  its_readout, C5 before_after_14d, C6 placebo_in_time (fed the real C4 result so it
  never recomputes it), and C8 belief_direction. ITS is authoritative: belief is
  projected from the ITS result alone (placebo-gated), never the naive cross-check.

Multiple-comparison control: running one readout per action against the SAME metric is
a family of tests, so a per-action "CI excludes 0" (nominal p<0.05) inflates false
edges as the action count grows. We collect the actions' step p_values and apply
Benjamini-Hochberg FDR at level q across them: an action earns belief 1.0 only if it
BOTH clears BH-FDR AND its placebo did not fire. A would-be 1.0 edge that fails BH-FDR
is demoted to 0.5 / INCONCLUSIVE (not significant after correction). Weaker verdicts
(0.5 / 0.0 / None) are untouched — FDR only ever removes, never adds, confidence.

Invariant: max_actions caps the fan-out (a metric can collide with an unbounded number
  of actions); exceeding it is a caller error -> ValueError, raised before any compute.
  A degenerate/insufficient single action returns a defined ActionReadout, never a raise.
"""

from __future__ import annotations

from causal.before_after_14d import before_after_14d
from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import ActionReadout, Belief, Series


def bh_fdr(p_values: list[float | None], q: float = 0.05) -> set[int]:
    """Benjamini-Hochberg step-up at level q over the non-None p_values.

    Returns the set of ORIGINAL indices whose hypothesis is rejected (discovery).
    None entries are untested (no OK readout) and are never rejected. Standard BH:
    with m tested p-values, let k = max rank r (1-based, ascending) s.t.
    p_(r) <= (r/m)*q; reject the k smallest. m == 0 -> nothing rejected.
    """
    tested = [(i, p) for i, p in enumerate(p_values) if p is not None]
    m = len(tested)
    if m == 0:
        return set()
    tested.sort(key=lambda ip: ip[1])
    max_rank = 0
    for rank, (_, p) in enumerate(tested, start=1):
        if p <= (rank / m) * q:
            max_rank = rank
    return {tested[r][0] for r in range(max_rank)}


def batch_readout(
    series: Series,
    action_splits: list[tuple[str, int]],
    max_actions: int = 200,
    q: float = 0.05,
) -> list[ActionReadout]:
    if len(action_splits) > max_actions:
        raise ValueError(
            f"{len(action_splits)} actions exceeds max_actions={max_actions}"
        )

    # First pass: the per-action readouts (ITS is computed once and reused by C6).
    computed = []
    for action_ref, split in action_splits:
        view = Series(series.dates, series.values, int(split))
        its = its_readout(view)
        computed.append(
            (action_ref, view, its, before_after_14d(view),
             placebo_in_time(view, its))
        )

    # BH-FDR across the family of per-action step tests for this metric.
    discoveries = bh_fdr([its.p_value for _, _, its, _, _ in computed], q)

    readouts = []
    for i, (action_ref, _, its, before_after, placebo) in enumerate(computed):
        belief = belief_direction(its, placebo)
        # A 1.0 edge must also survive multiple-comparison correction; if not, the
        # effect is not significant after FDR -> demote to 0.5 / INCONCLUSIVE.
        if belief.belief_score == 1.0 and i not in discoveries:
            belief = Belief(0.5, "INCONCLUSIVE")
        readouts.append(
            ActionReadout(action_ref, its, before_after, placebo, belief)
        )
    return readouts
