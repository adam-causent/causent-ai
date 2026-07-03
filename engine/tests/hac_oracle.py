"""Test-only Newey-West HAC covariance oracle (independent numpy reimplementation).

scipy ships no HAC estimator, so the golden CI/direction tests need one independent
source of truth for the Bartlett-kernel sandwich the engine reports. Keeping it here
(one place, not re-derived per file) obeys the "one implementation of the statistics"
rule while staying separate from the shipped code in causal/segmented_ols.py.

    cov = (X'X)^-1 Ω (X'X)^-1,  Ω = Γ_0 + Σ_{l=1..L} w_l (Γ_l + Γ_l'),
    w_l = 1 - l/(L+1),  L = floor(4*(n/100)^(2/9)),  Γ_l = Σ_t u_t u_{t-l}',  u_t = x_t e_t
"""

import numpy as np


def hac_lag(n: int) -> int:
    return max(0, min(int(np.floor(4.0 * (n / 100.0) ** (2.0 / 9.0))), n - 1))


def hac_cov(X: np.ndarray, resid: np.ndarray) -> np.ndarray:
    n = X.shape[0]
    lag = hac_lag(n)
    u = X * resid[:, None]
    omega = u.T @ u
    for l in range(1, lag + 1):
        w = 1.0 - l / (lag + 1.0)
        g = u[l:].T @ u[:-l]
        omega = omega + w * (g + g.T)
    bread = np.linalg.pinv(X.T @ X)
    return bread @ omega @ bread
