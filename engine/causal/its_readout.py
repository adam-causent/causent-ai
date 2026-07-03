"""C4 — the authoritative ITS readout, pure numpy.

Why: this is the one result that drives an edge's direction + belief
(decision-graph.md). It composes C2 (segmented_ols) and C3 (step_ci) into a
single honest verdict and never reports a number the data can't support.

Contract: its_readout(series) -> ITSResult, method "ITS".
  - n_pre < 14 or n_post < 14        -> INSUFFICIENT (no fit; the <28-point floor)
  - segmented_ols degenerate         -> DEGENERATE   (rank / condition / variance)
  - fittable but a side < FLOOR_CONFIDENT -> INSUFFICIENT_HISTORY: "not yet evaluable,
    gathering data" — direction INCONCLUSIVE, lift/ci/p withheld, so belief is None.
    No SE correction makes a confident causal claim honest on autocorrelated daily
    data below the floor (see tests/test_autocorrelation_coverage.py), so we don't.
  - otherwise                        -> OK: lift = step coefficient with a 95% CI;
    direction = sign(lift) when the CI excludes 0, else INCONCLUSIVE.
  lift/ci/p are None unless status is OK; durbin_watson is surfaced on OK so the belief
  layer can cap on residual autocorrelation; n_pre/n_post are always real counts;
  resid_var/cond_number carry the fit diagnostics (None if non-finite).
"""

from __future__ import annotations

from math import isfinite, sqrt

from causal.segmented_ols import segmented_ols
from causal.step_ci import step_ci
from causal.t_ppf import t_two_sided_p
from causal.types import FLOOR_CONFIDENT, MIN_SIDE, ITSResult, Series


def its_readout(series: Series) -> ITSResult:
    n_pre = int(series.split)
    n_post = int(series.values.size) - n_pre

    if n_pre < MIN_SIDE or n_post < MIN_SIDE:
        return ITSResult("ITS", "INSUFFICIENT", None, None, None,
                         "INCONCLUSIVE", n_pre, n_post, None, None)

    fit = segmented_ols(series)
    resid_var = fit.resid_var if isfinite(fit.resid_var) else None
    cond = fit.cond_number if isfinite(fit.cond_number) else None

    if fit.degenerate:
        return ITSResult("ITS", "DEGENERATE", None, None, None,
                         "INCONCLUSIVE", fit.n_pre, fit.n_post, resid_var, cond)

    # Fittable, but below the confident floor: honestly withhold the claim.
    if fit.n_pre < FLOOR_CONFIDENT or fit.n_post < FLOOR_CONFIDENT:
        return ITSResult("ITS", "INSUFFICIENT_HISTORY", None, None, None,
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

    dw = fit.durbin_watson if isfinite(fit.durbin_watson) else None
    return ITSResult("ITS", "OK", lift, ci_low, ci_high, direction,
                     fit.n_pre, fit.n_post, resid_var, cond, p_value, dw)
