"""C6 — placebo-in-time falsification, pure numpy.

Why: a real ITS readout is only trustworthy if the same method finds NOTHING when
aimed at a fake intervention where nothing shipped. This re-runs C4 on a split
placed at the midpoint of the pre-history; if that placebo shows a comparable or
statistically significant "effect", the method is fitting spurious structure and
the real readout is suspect (fired=True). See decision-graph.md ("trust unverified").

Contract: placebo_in_time(series) -> PlaceboResult.
  Fake split = midpoint of the pre-history. It must keep >= window (14d) on its pre
  side and sit >= 2*window (28d) before the real split, so the placebo's post-window
  never touches the real intervention. When that window can't be built, or C4 can't
  fit it -> INSUFFICIENT (placebo_lift=None, fired=False).
  Otherwise status OK and
    fired = |placebo_lift| >= 0.5*|real_lift|  OR  placebo 95% CI excludes 0.
"""

from __future__ import annotations

from causal.its_readout import its_readout
from causal.types import PlaceboResult, Series

_WINDOW = 14  # per-side day floor, shared with C4/C5


def placebo_in_time(series: Series) -> PlaceboResult:
    split = int(series.split)
    placebo_split = split // 2  # midpoint of the pre-history
    if placebo_split < _WINDOW or split - placebo_split < 2 * _WINDOW:
        return PlaceboResult("INSUFFICIENT", None, False)

    placebo = its_readout(
        Series(series.dates[:split], series.values[:split], placebo_split)
    )
    if placebo.status != "OK":
        return PlaceboResult("INSUFFICIENT", None, False)

    real_lift = its_readout(series).lift
    magnitude_fires = real_lift is not None and abs(placebo.lift) >= 0.5 * abs(real_lift)
    ci_excludes_zero = placebo.direction != "INCONCLUSIVE"
    return PlaceboResult("OK", placebo.lift, magnitude_fires or ci_excludes_zero)
