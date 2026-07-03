"""C9 — batch readout for one metric across many actions, pure numpy.

Why: the pipeline runs ONE engine call per metric and gets back one row per action
(decision-graph.md, step 3). Each action shares the metric's daily series but has its
own intervention point (its effective_date -> `split`). This fans that shared series
out into a per-action ITS readout, its descriptive cross-check, its placebo check, and
the belief projection — the exact ActionReadout rows the edge/evidence writer consumes.

Contract: batch_readout(series, action_splits, max_actions=200) -> list[ActionReadout],
  one per (action_ref, split), in input order. For each action we build the per-action
  view Series(series.dates, series.values, split) and run C4 its_readout, C5
  before_after_14d, C6 placebo_in_time, and C8 belief_direction. ITS is authoritative:
  belief is projected from the ITS result alone, never the naive cross-check.

Invariant: max_actions caps the fan-out (a metric can collide with an unbounded number
  of actions); exceeding it is a caller error -> ValueError, raised before any compute.
  A degenerate/insufficient single action returns a defined ActionReadout, never a raise.
"""

from __future__ import annotations

from causal.before_after_14d import before_after_14d
from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import ActionReadout, Series


def batch_readout(
    series: Series,
    action_splits: list[tuple[str, int]],
    max_actions: int = 200,
) -> list[ActionReadout]:
    if len(action_splits) > max_actions:
        raise ValueError(
            f"{len(action_splits)} actions exceeds max_actions={max_actions}"
        )

    readouts = []
    for action_ref, split in action_splits:
        view = Series(series.dates, series.values, int(split))
        its = its_readout(view)
        readouts.append(
            ActionReadout(
                action_ref,
                its,
                before_after_14d(view),
                placebo_in_time(view),
                belief_direction(its),  # ITS is authoritative for belief
            )
        )
    return readouts
