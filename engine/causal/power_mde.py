"""C7 — power / minimum-detectable-effect proxy, pure numpy.

Why: before an action is even attached to a metric we want to know whether the
metric is *detectable enough* to carry a verdict — a noisy, low-signal series
can never support a readout no matter what ships. This estimates the minimum
detectable effect (MDE) from the PRE-history variance alone (no intervention
needed) and flags the metric underpowered when that MDE exceeds the smallest
effect we'd care about. A cheap gate that stops the graph promising a precision
the data can't deliver (decision-graph.md, statistical honesty).

Contract: power_mde(series, target_frac, alpha, power) -> PowerResult.
  var = residual variance of a linear (level + slope) detrend of the pre-history,
        df = n_pre - 2 (the full pre-history stabilizes the variance estimate).
  n_win = min(n_pre, 14) — the effective per-side sample the readout actually uses.
  mde = (t_ppf(1-alpha/2, df) + t_ppf(power, df)) * sqrt(var * (1/n_win + 1/n_win)).
  underpowered = mde > target_frac * abs(mean(pre)).

  Why n_win, not n_pre: the authoritative readout compares FIXED +/-14-day windows
  around the intervention (the spec's before/after window), so its detection power is
  capped by those 14 points regardless of how much history accumulates. Dividing the
  standard error by the full n_pre would let a genuinely underpowered metric silently
  clear the gate as its history grows longer; pinning the effective n at the 14-day
  window keeps the MDE honest.

Invariant: too little pre-history to detrend (n_pre < 3), a non-finite value in
the pre-window, or a rank-deficient time axis has no defensible MDE -> mde=None
and underpowered=True (we never certify power we cannot compute). A perfectly
linear pre-history has zero residual variance -> mde=0.0 (any effect detectable).
alpha/power outside (0, 1) is a caller error -> ValueError.
"""

from __future__ import annotations

from math import isfinite, sqrt

import numpy as np

from causal.t_ppf import t_ppf
from causal.types import MIN_SIDE, PowerResult, Series


def power_mde(series: Series, target_frac: float = 0.05,
              alpha: float = 0.05, power: float = 0.8) -> PowerResult:
    if not 0.0 < alpha < 1.0:
        raise ValueError(f"alpha must be in (0, 1), got {alpha!r}")
    if not 0.0 < power < 1.0:
        raise ValueError(f"power must be in (0, 1), got {power!r}")

    n_pre = int(series.split)
    df = n_pre - 2
    pre = series.values[:n_pre].astype(np.float64)
    if df <= 0 or not np.isfinite(pre).all():
        return PowerResult(None, True)

    t = series.dates[:n_pre].astype(np.float64)
    X = np.column_stack((np.ones(n_pre), t - t.mean()))
    coeffs, _, rank, _ = np.linalg.lstsq(X, pre, rcond=None)
    if rank < 2:                       # degenerate time axis: no trend to remove
        return PowerResult(None, True)

    resid = pre - X @ coeffs
    var = float(resid @ resid / df)
    if not isfinite(var):
        return PowerResult(None, True)

    n_win = min(n_pre, MIN_SIDE)  # fixed +/-14-day readout window caps the power
    mde = (t_ppf(1.0 - alpha / 2.0, float(df)) + t_ppf(power, float(df))) \
        * sqrt(var * (2.0 / n_win))
    return PowerResult(mde, mde > target_frac * abs(float(pre.mean())))
