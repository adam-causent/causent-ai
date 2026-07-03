"""C6 — placebo-in-time falsification, pure numpy.

Why: a real ITS readout is only trustworthy if the same method finds NOTHING when
aimed at a fake intervention where nothing shipped. This re-runs C4 on a split
placed at the midpoint of the pre-history; if that placebo shows a comparable or
statistically significant "effect", the method is fitting spurious structure and
the real readout is suspect (fired=True). See decision-graph.md ("trust unverified").

Contract: placebo_in_time(series, real=None) -> PlaceboResult.
  Fake split = midpoint of the pre-history. It must keep >= window (14d) on its pre
  side and sit >= 2*window (28d) before the real split, so the placebo's post-window
  never touches the real intervention. When that window can't be built, or C4 can't
  fit it -> INSUFFICIENT (placebo_lift=None, fired=False).
  Otherwise status OK and
    fired = placebo 95% CI excludes 0  OR  (real readout is OK AND
            |placebo_lift| >= 0.5*|real_lift|).

`real` is the caller's already-computed C4 readout on the SAME series (batch_readout
has it in hand); passing it avoids recomputing the real ITS here (the 3x recompute).
When omitted it is computed once. The magnitude clause needs a real effect to compare
against, so it is only consulted when `real` is OK — a placebo can still fire on its
own significant CI even when the real readout is INSUFFICIENT (nothing to compare to).
"""

from __future__ import annotations

from causal.its_readout import its_readout
from causal.types import ITSResult, PlaceboResult, Series

_WINDOW = 14  # per-side day floor, shared with C4/C5


def placebo_in_time(series: Series, real: ITSResult | None = None) -> PlaceboResult:
    split = int(series.split)
    placebo_split = split // 2  # midpoint of the pre-history
    if placebo_split < _WINDOW or split - placebo_split < 2 * _WINDOW:
        return PlaceboResult("INSUFFICIENT", None, False)

    placebo = its_readout(
        Series(series.dates[:split], series.values[:split], placebo_split)
    )
    if placebo.status != "OK":
        return PlaceboResult("INSUFFICIENT", None, False)

    if real is None:
        real = its_readout(series)
    real_lift = real.lift if real.status == "OK" else None
    magnitude_fires = real_lift is not None and abs(placebo.lift) >= 0.5 * abs(real_lift)
    ci_excludes_zero = placebo.direction != "INCONCLUSIVE"
    return PlaceboResult("OK", placebo.lift, magnitude_fires or ci_excludes_zero)
