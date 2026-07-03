"""C1 — Student-t inverse CDF (quantile), pure numpy.

Why: every CI/readout downstream (ITS lift, before/after) needs a t critical
value; scipy is not on the Vercel Python runtime, so we own the quantile.

Contract: t_ppf(p, df) is the value t with P(T <= t) = p for T ~ Student-t(df).
  - strictly increasing in p on (0, 1); p<=0 -> -inf, p>=1 -> +inf, p=0.5 -> 0
  - antisymmetric: t_ppf(p, df) == -t_ppf(1 - p, df)  (up to the rounding of 1-p)
Invalid df (<=0, nan) or p (nan, <0, >1) raise ValueError — never a fabricated number.

Method: reduce to the lower tail q = min(p, 1-p), seed with the Abramowitz &
Stegun 26.7.5 expansion, then solve I_x(df/2, 1/2) = 2q for x = df/(df+t^2) by
Newton on the regularized incomplete beta with a bisection bracket [0,1] as an
unconditional safety net (guarantees convergence even for df=1 / heavy tails).
"""

from __future__ import annotations

from math import exp, lgamma, log, sqrt

# Acklam rational-approximation coefficients for the standard normal quantile.
_A = (-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
      1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00)
_B = (-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
      6.680131188771972e01, -1.328068155288572e01)
_C = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
      -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00)
_D = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
      3.754408661907416e00)


def _norm_ppf(p: float) -> float:
    """Standard normal inverse CDF (Acklam), ~1e-9 abs error over (0,1)."""
    if p < 0.02425:
        q = sqrt(-2.0 * log(p))
        return (((((_C[0]*q+_C[1])*q+_C[2])*q+_C[3])*q+_C[4])*q+_C[5]) / \
               ((((_D[0]*q+_D[1])*q+_D[2])*q+_D[3])*q+1.0)
    if p <= 0.97575:
        q = p - 0.5
        r = q * q
        return (((((_A[0]*r+_A[1])*r+_A[2])*r+_A[3])*r+_A[4])*r+_A[5])*q / \
               (((((_B[0]*r+_B[1])*r+_B[2])*r+_B[3])*r+_B[4])*r+1.0)
    q = sqrt(-2.0 * log(1.0 - p))
    return -(((((_C[0]*q+_C[1])*q+_C[2])*q+_C[3])*q+_C[4])*q+_C[5]) / \
            ((((_D[0]*q+_D[1])*q+_D[2])*q+_D[3])*q+1.0)


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction for the incomplete beta (Lentz), converges where x < (a+1)/(a+b+2)."""
    tiny = 1e-30
    c = 1.0
    d = 1.0 - (a + b) * x / (a + 1.0)
    if abs(d) < tiny:
        d = tiny
    d = 1.0 / d
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        aa = m * (b - m) * x / ((a + m2 - 1.0) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1.0))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    return h


def _betainc(a: float, b: float, x: float) -> float:
    """Regularized incomplete beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    front = exp(a * log(x) + b * log(1.0 - x) - (lgamma(a) + lgamma(b) - lgamma(a + b)))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def t_two_sided_p(t: float, df: float) -> float:
    """Two-sided p-value P(|T| > |t|) for T ~ Student-t(df).

    Uses the identity P(|T| > t) = I_x(df/2, 1/2) with x = df/(df+t^2), reusing the
    same regularized incomplete beta that backs t_ppf. t=0 -> 1.0, |t|->inf -> 0.0.
    """
    if not df > 0.0:
        raise ValueError(f"df must be > 0, got {df!r}")
    x = df / (df + t * t)
    return _betainc(0.5 * df, 0.5, x)


def t_ppf(p: float, df: float) -> float:
    if not df > 0.0:                       # also rejects nan
        raise ValueError(f"df must be > 0, got {df!r}")
    if not (0.0 <= p <= 1.0):              # also rejects nan
        raise ValueError(f"p must be in [0, 1], got {p!r}")
    if p == 0.0:
        return float("-inf")
    if p == 1.0:
        return float("inf")
    if p == 0.5:
        return 0.0

    q = p if p < 0.5 else 1.0 - p          # lower-tail prob in (0, 0.5)
    a, b = 0.5 * df, 0.5                    # x = df/(df+t^2) solves I_x(a,b) = 2q
    lbeta = lgamma(a) + lgamma(b) - lgamma(a + b)

    # Seed x from the A&S 26.7.5 t-quantile expansion (z < 0 for the lower tail).
    z = _norm_ppf(q)
    z2 = z * z
    t = z + (z * (z2 + 1.0)) / (4.0 * df) \
        + (z * (5.0 * z2 * z2 + 16.0 * z2 + 3.0)) / (96.0 * df * df) \
        + (z * (3.0 * z2**3 + 19.0 * z2 * z2 + 17.0 * z2 - 15.0)) / (384.0 * df**3)
    x = df / (df + t * t)

    # Solve in whichever beta variable is <= 0.5 so log() never sees an underflowed
    # argument (x->1 near the median, x->0 in the deep tails). Split at I_{1/2}(a,b).
    y = 2.0 * q
    lower_half = y <= _betainc(a, b, 0.5)   # is x <= 1/2 ?
    if lower_half:                          # iterate on v = x, params (a, b)
        pa, pb, target, v = a, b, y, min(max(x, 1e-300), 0.5)
    else:                                   # iterate on v = 1-x, params (b, a)
        pa, pb, target, v = b, a, 1.0 - y, min(max(1.0 - x, 1e-300), 0.5)

    lo, hi = 0.0, 0.5
    for _ in range(80):
        f = _betainc(pa, pb, v) - target
        if f > 0.0:
            hi = v
        else:
            lo = v
        if abs(f) < 1e-15:
            break
        deriv = exp((pa - 1.0) * log(v) + (pb - 1.0) * log(1.0 - v) - lbeta)
        nv = v - f / deriv if deriv > 0.0 else 0.5 * (lo + hi)
        if not (lo < nv < hi):
            nv = 0.5 * (lo + hi)
        if abs(nv - v) <= 1e-16 * v:
            v = nv
            break
        v = nv

    x = v if lower_half else 1.0 - v
    mag = sqrt(df * (1.0 - x) / x)
    return -mag if p < 0.5 else mag
