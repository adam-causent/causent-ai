"""Always-on descriptive stat — the number the user ALWAYS sees, pure numpy.

Why: the causal ITS readout withholds below FLOOR_CONFIDENT ("gathering data"), but
the user still needs *something* honest to look at from day one. This is that
something: a plain mean(post) - mean(pre) over two windows (7 and 14 days). It is
DESCRIPTIVE, never causal — no confidence interval, no significance, no belief. It
never gates and never returns INSUFFICIENT; it reports whatever the data supports.

Contract: descriptive(series) -> DescriptiveResult, kind "DESCRIPTIVE".
  For each window W in (7, 14): average the last min(W, n_pre) pre-split points and
  the first min(W, n_post) post-split points; lift = post_mean - pre_mean. A side with
  no points (or only non-finite values) yields None for that mean and for the lift;
  the other window/side is unaffected. n_pre/n_post on each WindowStat report how many
  points were actually averaged, so a partial (<W) window is transparent, never hidden.
"""

from __future__ import annotations

import numpy as np

from causal.types import DescriptiveResult, Series, WindowStat


def _window(values: np.ndarray, split: int, window_days: int) -> WindowStat:
    pre = values[max(0, split - window_days):split]
    post = values[split:split + window_days]
    pre = pre[np.isfinite(pre)]
    post = post[np.isfinite(post)]
    pre_mean = float(pre.mean()) if pre.size else None
    post_mean = float(post.mean()) if post.size else None
    lift = post_mean - pre_mean if (pre_mean is not None and post_mean is not None) else None
    return WindowStat(window_days, int(pre.size), int(post.size), pre_mean, post_mean, lift)


def descriptive(series: Series) -> DescriptiveResult:
    values = series.values.astype(np.float64)
    split = int(series.split)
    return DescriptiveResult(
        kind="DESCRIPTIVE",
        window_7d=_window(values, split, 7),
        window_14d=_window(values, split, 14),
    )
