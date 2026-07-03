"""C2 — segmented OLS for interrupted time series, pure numpy.

Why: the authoritative ITS readout (C4) needs the level shift at the intervention
plus its covariance. This fits that segmented regression once and hands the raw
solve (coeffs + cov + diagnostics) downstream, so belief can be recomputed later
without re-running the engine (see decision-graph.md, "capture raw stats now").

Contract: segmented_ols(series) -> Fit for the model
    y = level + pre_slope * t_centered + step * D  [ + post_slope * (t - t_split)*D ]
  D = 1 on/after `split`. The post_slope column is fitted ONLY when each side has
  >= 28 points (else it is unidentifiable / noisy), so coeffs is length 3 or 4.
  t is centered to decorrelate level from slope and keep the design well-conditioned.

Covariance: daily business metrics are serially correlated, so iid OLS SEs are
understated and CIs too narrow (the panel's headline blocker). We report the
Newey-West HAC covariance instead — a Bartlett-kernel sandwich
    cov = (X'X)^-1 (X' Ω X) (X'X)^-1,  Ω via lags 0..L, weight w_l = 1 - l/(L+1),
    auto lag L = floor(4*(n/100)^(2/9))
— which is consistent under autocorrelation and reduces to sigma^2 (X'X)^-1 when
residuals are white. The Durbin-Watson statistic (~2 = no autocorrelation) and the
chosen lag are stored as diagnostics on the Fit.

Invariant: degenerate inputs return a defined Fit with degenerate=True — never a
raise, never NaN. Degenerate = too few points, rank-deficient design (e.g. split
at an end collapses D into the intercept), condition number past _COND_MAX, or a
flat metric (variance below _VAR_FLOOR) that carries no signal to explain.
"""

from __future__ import annotations

import numpy as np

from causal.types import Fit, Series

_MIN_SEG = 28       # min points per side to identify a separate post-slope
_COND_MAX = 1e10    # design condition number above this => unreliable solve
_VAR_FLOOR = 1e-10  # metric variance below this => no signal to explain


def _hac_lag(n: int) -> int:
    """Automatic Bartlett truncation lag floor(4*(n/100)^(2/9)), clamped to [0, n-1]."""
    lag = int(np.floor(4.0 * (n / 100.0) ** (2.0 / 9.0)))
    return max(0, min(lag, n - 1))


def _newey_west_cov(X: np.ndarray, resid: np.ndarray, bread: np.ndarray, lag: int):
    """HAC sandwich cov = bread @ Ω @ bread with a Bartlett-weighted Ω over lags 0..lag."""
    u = X * resid[:, None]              # per-obs score contributions, (n, k)
    meat = u.T @ u                      # Γ_0
    for l in range(1, lag + 1):
        w = 1.0 - l / (lag + 1.0)       # Bartlett weight
        g = u[l:].T @ u[:-l]            # Γ_l
        meat = meat + w * (g + g.T)
    return bread @ meat @ bread


def segmented_ols(series: Series) -> Fit:
    y = series.values.astype(np.float64)
    t = series.dates.astype(np.float64)
    n = y.size
    split = int(series.split)
    n_pre, n_post = split, n - split

    finite = np.isfinite(y).all() and np.isfinite(t).all()
    post = np.arange(n) >= split
    tc = (t - t.mean()) if finite else np.zeros(n)
    cols = [np.ones(n), tc, post.astype(np.float64)]
    if n_pre >= _MIN_SEG and n_post >= _MIN_SEG:
        cols.append(np.where(post, t - t[split], 0.0) if finite else np.zeros(n))
    X = np.column_stack(cols)
    k = X.shape[1]

    if n < k or not finite:
        return Fit(np.zeros(k), np.zeros((k, k)), float("inf"),
                   float("inf"), n_pre, n_post, True)

    coeffs, _, rank, s = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coeffs
    dof = n - rank
    cond = float(s[0] / s[-1]) if s[-1] > 0.0 else float("inf")
    resid_var = float(resid @ resid / dof) if dof > 0 else float("inf")

    lag = _hac_lag(n)
    cov = _newey_west_cov(X, resid, np.linalg.pinv(X.T @ X), lag)
    ss = float(resid @ resid)
    dw = float(np.sum(np.diff(resid) ** 2) / ss) if ss > 0.0 else float("nan")

    degenerate = bool(
        rank < k or cond > _COND_MAX or dof <= 0 or float(y.var()) < _VAR_FLOOR
    )
    return Fit(coeffs, cov, resid_var, cond, n_pre, n_post, degenerate, dw, lag)
