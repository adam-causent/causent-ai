"""C4 — the authoritative ITS readout, pure numpy.

Why: this is the one result that drives an edge's direction + belief
(decision-graph.md). It composes C2 (segmented_ols) and C3 (step_ci) into a
single honest verdict and never reports a number the data can't support.

Contract: its_readout(series) -> ITSResult, method "ITS".
  - n_pre < 14 or n_post < 14   -> INSUFFICIENT (no fit; the <28-point floor)
  - segmented_ols degenerate    -> DEGENERATE   (rank / condition / variance)
  - otherwise                   -> OK: lift = step coefficient with a 95% CI;
    direction = sign(lift) when the CI excludes 0, else INCONCLUSIVE.
  lift/ci are None unless status is OK; p_value is the two-sided step p from the
  HAC SE (None unless OK); n_pre/n_post are always real counts; resid_var/
  cond_number carry the fit diagnostics (None if non-finite).
"""

from __future__ import annotations

from math import isfinite, sqrt

from causal.segmented_ols import segmented_ols
from causal.step_ci import step_ci
from causal.t_ppf import t_two_sided_p
from causal.types import ITSResult, Series

_MIN_SIDE = 14  # per-side floor; 14 + 14 = the 28-point minimum for a readout


def its_readout(series: Series) -> ITSResult:
    n_pre = int(series.split)
    n_post = int(series.values.size) - n_pre

    if n_pre < _MIN_SIDE or n_post < _MIN_SIDE:
        return ITSResult("ITS", "INSUFFICIENT", None, None, None,
                         "INCONCLUSIVE", n_pre, n_post, None, None)

    fit = segmented_ols(series)
    resid_var = fit.resid_var if isfinite(fit.resid_var) else None
    cond = fit.cond_number if isfinite(fit.cond_number) else None

    if fit.degenerate:
        return ITSResult("ITS", "DEGENERATE", None, None, None,
                         "INCONCLUSIVE", fit.n_pre, fit.n_post, resid_var, cond)

    lift = float(fit.coeffs[2])
    ci_low, ci_high = step_ci(fit)
    if ci_low > 0.0:
        direction = "POSITIVE"
    elif ci_high < 0.0:
        direction = "NEGATIVE"
    else:
        direction = "INCONCLUSIVE"

    df = fit.n_pre + fit.n_post - int(fit.coeffs.size)
    se = sqrt(float(fit.cov[2, 2]))
    if se > 0.0:
        p_value = t_two_sided_p(lift / se, float(df))
    else:  # perfect (zero-variance) fit: any non-zero step is certain
        p_value = 1.0 if lift == 0.0 else 0.0

    return ITSResult("ITS", "OK", lift, ci_low, ci_high, direction,
                     fit.n_pre, fit.n_post, resid_var, cond, p_value)
