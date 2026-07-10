"""C6 — placebo-in-time falsification, pure numpy.

Why: a real ITS readout is only trustworthy if the same method finds NOTHING when
aimed at a fake intervention where nothing shipped. This re-runs the segmented fit on
a fake split inside the pre-history; if that placebo shows a comparable or
significant "effect", the method is fitting spurious structure and the real readout is
suspect (fired=True). See decision-graph.md ("trust unverified").

Contract: placebo_in_time(series, real=None) -> PlaceboResult.
  The fake split is placed so a full 14-day pre and 14-day post window fit ENTIRELY
  within the available pre-history: the placebo post-window is the 14 days immediately
  before the real intervention (placebo_split = split - 14) and its pre-window is all
  history before that. This fires in the engine's real operating regime (any real split
  >= 2*MIN_SIDE = 28), unlike a split//2 placement whose post-window ran into the real
  intervention and needed ~112 days of history before it could be built at all.
  When 14+14 cannot fit (split < 28), or the placebo fit is degenerate, the placebo is
  NOT evaluable -> INSUFFICIENT (placebo_lift=None, fired=False) — an explicit "not
  evaluable", never a silent non-fire. belief_direction withholds a confident 1.0 when
  the placebo could not confirm the readout.

  fired = placebo (1 - PLACEBO_ALPHA) CI excludes 0   (a strong, conservatively-screened
          spurious pre-period step)
        OR (real readout is a SIGNIFICANT effect AND |placebo_lift| >= 0.5*|real_lift|).
  The magnitude clause only applies when the real readout is significant (its CI excludes
  0): there is no real effect for the placebo to "recover half of" when the real CI
  includes 0, so on a null readout the clause is skipped (it would otherwise trip on
  float-scale noise, since 0.5*|real_lift| ~ 0).
  The placebo uses the raw segmented fit + step_ci directly (NOT its_readout, whose
  FLOOR_CONFIDENT gate would reject the 14-day placebo post-window). PLACEBO_ALPHA is
  stricter than 0.05: null control is carried by the floor + Durbin-Watson cap, so the
  placebo is a conservative veto that only fires on egregious pre-period structure and
  does not erase genuine effects.

`real` is the caller's already-computed C4 readout on the SAME series (batch_readout has
it in hand); passing it avoids recomputing the real ITS here. The magnitude clause needs
a real effect to compare against, so it is only consulted when `real` is OK.
"""

from __future__ import annotations

from math import isfinite

from causal.its_readout import direction_tol, its_readout
from causal.segmented_ols import segmented_ols
from causal.step_ci import step_ci
from causal.types import MIN_SIDE, PLACEBO_ALPHA, ITSResult, PlaceboResult, Series

_NOT_EVALUABLE = PlaceboResult("INSUFFICIENT", None, False)


def placebo_in_time(series: Series, real: ITSResult | None = None) -> PlaceboResult:
    split = int(series.split)
    if split < 2 * MIN_SIDE:                       # 14 pre + 14 post won't fit in pre-history
        return _NOT_EVALUABLE

    placebo_split = split - MIN_SIDE               # post-window = 14 days before the real split
    fit = segmented_ols(Series(series.dates[:split], series.values[:split], placebo_split))
    if fit.degenerate:
        return _NOT_EVALUABLE

    ci_low, ci_high = step_ci(fit, alpha=PLACEBO_ALPHA)
    if not (isfinite(ci_low) and isfinite(ci_high)):
        return _NOT_EVALUABLE

    placebo_lift = float(fit.coeffs[2])
    # Dead-zone against the float dust of a zero-residual placebo fit (a perfectly
    # linear pre-window collapses the CI to a point at ~1e-14; a hard `> 0.0` test
    # would fire nondeterministically on the dust's sign). Scale to the pre-window.
    tol = direction_tol(series.values[:split])
    ci_excludes_zero = ci_low > tol or ci_high < -tol
    if real is None:                    # compute the real readout once when not supplied
        real = its_readout(series)
    real_significant = real.status == "OK" and real.direction != "INCONCLUSIVE"
    real_lift = real.lift if real_significant else None
    magnitude_fires = real_lift is not None and abs(placebo_lift) >= 0.5 * abs(real_lift)
    return PlaceboResult("OK", placebo_lift, ci_excludes_zero or magnitude_fires)
