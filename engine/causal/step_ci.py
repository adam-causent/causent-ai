"""C3 — confidence interval for the ITS step coefficient, pure numpy.

Why: the authoritative readout (C4) reports the level shift with honest
uncertainty. This turns C2's raw solve into a two-sided (1-alpha) interval
using the fitted covariance (C2's autocorrelation-robust Newey-West HAC cov)
and the t critical value C1 owns.

Contract: step_ci(fit, alpha) -> (low, high) for the step coefficient
  (coeffs[2]) at confidence 1-alpha. Interval = step ± t_ppf(1-alpha/2, df) *
  sqrt(cov[2,2]), df = n_pre + n_post - k, k = number of fitted coefficients.

Invariant: a degenerate fit (or df <= 0, or a non-finite variance) has no
defensible interval and returns (nan, nan) — never a fabricated width, never a
raise. A perfectly-fit (zero-variance) non-degenerate model collapses to the
point estimate (step, step). alpha out of (0, 1) is a caller error -> ValueError.
"""

from __future__ import annotations

from math import isfinite, sqrt

from causal.t_ppf import t_ppf
from causal.types import Fit


def step_ci(fit: Fit, alpha: float = 0.05) -> tuple[float, float]:
    if not 0.0 < alpha < 1.0:
        raise ValueError(f"alpha must be in (0, 1), got {alpha!r}")

    df = fit.n_pre + fit.n_post - int(fit.coeffs.size)
    var = float(fit.cov[2, 2])
    if fit.degenerate or df <= 0 or not isfinite(var) or var < 0.0:
        return (float("nan"), float("nan"))

    half = t_ppf(1.0 - alpha / 2.0, float(df)) * sqrt(var)
    step = float(fit.coeffs[2])
    return (step - half, step + half)
