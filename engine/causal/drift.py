"""C5/#18 — baseline-drift detector: did the metric's own baseline move under a
committed prediction? Pure numpy, a THIN change-point wrapper over the existing
segmented_ols (C2) + step_ci (C3). It does NOT re-implement the level-shift fit.

Why this exists (design: adamowens-main-design-20260712, "Baseline drift as the
demo's hero signal"): a PM commits "+3% activation"; weeks later the metric's
baseline slides from 20% to 12%. That is "drift of the world" — a change the
builder cannot see from their own seat and that Jira/Linear structurally cannot
report. Causent can, because it holds the committed belief AND the metric series.

The correctness crux (Eng review): baseline drift is searched in the
PRE-INTERVENTION window ONLY —

    [commit_date, ship_date)     when a lever has shipped, else
    [commit_date, series_end]    the common prospective case (no lever shipped).

Fitting over the whole post-commit window would read the LEVER'S OWN effect (a
step at ship_date) as "drift" and flag every working lever. Excluding the ship
date and everything after it separates "the world moved" from "my lever worked"
by construction. We scan candidate change-points strictly inside that window.

Fire / no-fire guard (design D3): FIRE only when, at the best change-point,
  1. the segmented_ols fit is non-degenerate (>= _MIN_SEG=28 points/side — the
     same floor C2 enforces; a shorter window can't fit and never fires), AND
  2. the step's confidence interval (step_ci, HAC-robust) EXCLUDES 0, AND
  3. the baseline move clears a magnitude floor (|pct_change| >= min_pct).
A metric with no in-window observations, or too few to fit any candidate, is
NO_BASELINE_YET ("gathering baseline") — never a fire. This mirrors the honest
INSUFFICIENT/DEGENERATE posture the ITS readout already takes.

Levels shown to the user (pre_level -> post_level) are the plain in-window
segment MEANS, so "baseline moved 20% -> 12%" reads as a fact; the fire decision
still rests on the rigorous fitted step + CI. A baseline move is neither a win
nor a loss — `direction` is the metric's movement only, never a verdict.

Contract: detect_baseline_drift(series, commit_ordinal, ship_ordinal, ...)
  -> DriftResult. `series` is the metric's FULL daily Series (its .split is
  ignored — the detector chooses its own splits inside the window). commit/ship
  are int64 ordinal days (ship None = prospective). Never raises on degenerate
  or empty input: it returns a defined NOT_FIRED / NO_BASELINE_YET DriftResult.
"""

from __future__ import annotations

import os
from math import isfinite, sqrt

import numpy as np

from causal.segmented_ols import _MIN_SEG, segmented_ols
from causal.step_ci import step_ci
from causal.types import DriftResult, Series

# Magnitude floor for a fire: the baseline must move at least this many percent of
# its own pre-shift mean. Below it a credible-but-tiny shift is not worth
# interrupting the belief-holder over. Env-overridable, like MAX_CLUSTER_SPAN_DAYS.
DRIFT_MIN_PCT = float(os.environ.get("CAUSENT_DRIFT_MIN_PCT", "5.0"))


def _window_bounds(
    dates: np.ndarray, commit_ordinal: int, ship_ordinal: int | None
) -> tuple[int, int]:
    """Half-open index range [lo, hi) of the pre-intervention window:
    commit_date <= obs_date < ship_date (or the tail from commit when ship is
    None). `dates` is sorted ascending (the bridge guarantees it)."""
    lo = int(np.searchsorted(dates, commit_ordinal, side="left"))
    hi = (
        dates.size
        if ship_ordinal is None
        else int(np.searchsorted(dates, ship_ordinal, side="left"))
    )
    return lo, hi


def detect_baseline_drift(
    series: Series,
    commit_ordinal: int,
    ship_ordinal: int | None,
    *,
    min_pct: float = DRIFT_MIN_PCT,
    alpha: float = 0.05,
) -> DriftResult:
    dates = np.asarray(series.dates, dtype=np.int64)
    values = np.asarray(series.values, dtype=np.float64)

    lo, hi = _window_bounds(dates, commit_ordinal, ship_ordinal)
    w_dates = dates[lo:hi]
    w_values = values[lo:hi]
    n = w_dates.size

    # No baseline to measure against: no in-window observations at all (a declared
    # metric that never received data), or too few points to fit ANY change-point
    # with >= _MIN_SEG per side. Both are "gathering baseline", never a fire.
    finite = np.isfinite(w_values)
    if finite.sum() == 0:
        return DriftResult("NO_BASELINE_YET", reason="no_observations")
    if n < 2 * _MIN_SEG:
        return DriftResult("NO_BASELINE_YET", n_pre=n, reason="gathering_baseline")

    # Scan candidate change-points inside the window; keep the most significant
    # non-degenerate level shift (largest |step| / SE). segmented_ols already
    # enforces the per-side floor and returns a defined degenerate Fit, never a raise.
    best_split = -1
    best_t = 0.0
    best_fit = None
    for split in range(_MIN_SEG, n - _MIN_SEG + 1):
        fit = segmented_ols(Series(w_dates, w_values, split))
        if fit.degenerate:
            continue
        var = float(fit.cov[2, 2])
        if not isfinite(var) or var <= 0.0:
            continue
        t_stat = abs(float(fit.coeffs[2])) / sqrt(var)
        if t_stat > best_t:
            best_t, best_split, best_fit = t_stat, split, fit

    if best_fit is None:
        # Every candidate fit was degenerate (e.g. a flat, no-variance window).
        return DriftResult("NOT_FIRED", n_pre=n, reason="no_significant_shift")

    # Plain before/after baselines for display (segment means): "moved 20% -> 12%".
    pre_seg = w_values[:best_split]
    post_seg = w_values[best_split:]
    pre_level = float(np.mean(pre_seg[np.isfinite(pre_seg)]))
    post_level = float(np.mean(post_seg[np.isfinite(post_seg)]))
    delta = post_level - pre_level
    pct_change = delta / abs(pre_level) * 100.0 if pre_level != 0.0 else float("inf")
    direction = "down" if delta < 0 else "up"

    ci_low, ci_high = step_ci(best_fit, alpha)
    n_pre = int(np.isfinite(pre_seg).sum())
    n_post = int(np.isfinite(post_seg).sum())

    common = dict(
        shift_ordinal=int(w_dates[best_split]),
        pre_level=pre_level,
        post_level=post_level,
        delta_native=delta,
        pct_change=pct_change,
        direction=direction,
        ci_low=ci_low if isfinite(ci_low) else None,
        ci_high=ci_high if isfinite(ci_high) else None,
        n_pre=n_pre,
        n_post=n_post,
    )

    # Fire guard: the step's CI must exclude 0 (a real shift, not noise) AND the
    # move must clear the magnitude floor (big enough to bother the belief-holder).
    ci_excludes_zero = isfinite(ci_low) and isfinite(ci_high) and (
        ci_low > 0.0 or ci_high < 0.0
    )
    if not ci_excludes_zero:
        return DriftResult("NOT_FIRED", reason="no_significant_shift", **common)
    if abs(pct_change) < min_pct:
        return DriftResult("NOT_FIRED", reason="below_floor", **common)

    return DriftResult("FIRED", reason="fired", **common)
