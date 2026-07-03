"""Tests for the always-on descriptive stat (7-day + 14-day mean-difference).

The descriptive readout is DESCRIPTIVE, not causal: it carries no CI, no significance,
and no belief. Its whole job is to always return a plain mean(post) - mean(pre) for two
windows, at EVERY history length — including below FLOOR_CONFIDENT, where the causal ITS
withholds. These tests pin exact arithmetic and the never-gated / partial-window behavior.
"""

import numpy as np
import pytest

from causal.descriptive import descriptive
from causal.types import DescriptiveResult, Series

_BASE = 738000


def _series(vals, split):
    vals = np.asarray(vals, float)
    return Series(_BASE + np.arange(vals.size), vals, split)


# ---------- golden: exact mean-difference on both windows ----------

def test_both_windows_exact_means():
    # 20 pre at 3.0, 20 post at 8.0: both windows read lift 5.0 exactly.
    r = descriptive(_series([3.0] * 20 + [8.0] * 20, 20))
    assert isinstance(r, DescriptiveResult) and r.kind == "DESCRIPTIVE"
    assert r.window_7d.lift == pytest.approx(5.0, abs=1e-12)
    assert r.window_14d.lift == pytest.approx(5.0, abs=1e-12)
    assert r.window_7d.window_days == 7 and r.window_14d.window_days == 14
    assert r.window_7d.n_pre == 7 and r.window_7d.n_post == 7
    assert r.window_14d.n_pre == 14 and r.window_14d.n_post == 14


def test_windows_use_only_their_own_span():
    # A tail spike 8 days before the split shifts the 14-day pre-mean but NOT the 7-day.
    vals = np.concatenate([[0.0] * 6, [70.0], [1.0] * 7, [4.0] * 7])  # split at 14
    r = descriptive(_series(vals, 14))
    assert r.window_7d.pre_mean == pytest.approx(1.0, abs=1e-12)   # last 7 pre = all 1.0
    assert r.window_7d.lift == pytest.approx(3.0, abs=1e-12)
    assert r.window_14d.pre_mean != pytest.approx(1.0)             # spike pulls it up


# ---------- never gated: returns a stat below the confident floor and even below MIN_SIDE ----------

def test_returns_below_the_floor():
    # 20/20 is below FLOOR_CONFIDENT (45) — the ITS withholds, but descriptive still reports.
    r = descriptive(_series([1.0] * 20 + [3.0] * 20, 20))
    assert r.window_7d.lift == pytest.approx(2.0, abs=1e-12)
    assert r.window_14d.lift == pytest.approx(2.0, abs=1e-12)


def test_partial_window_reports_actual_counts():
    # Only 3 pre and 5 post points: both windows use what exists (never INSUFFICIENT),
    # and the counts are reported honestly rather than padded.
    r = descriptive(_series([2.0] * 3 + [10.0] * 5, 3))
    for w in (r.window_7d, r.window_14d):
        assert w.n_pre == 3 and w.n_post == 5
        assert w.lift == pytest.approx(8.0, abs=1e-12)


def test_empty_side_yields_none_lift_not_a_crash():
    r = descriptive(_series([1.0] * 10, 10))  # no post points
    assert r.window_7d.post_mean is None and r.window_7d.lift is None
    assert r.window_7d.pre_mean == pytest.approx(1.0, abs=1e-12)


# ---------- non-finite values are dropped, never poison the mean ----------

def test_non_finite_values_are_ignored():
    vals = np.array([1.0, np.nan, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,   # 8 pre (one nan)
                     5.0, np.inf, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0])   # 8 post (one inf)
    r = descriptive(_series(vals, 8))
    assert r.window_7d.pre_mean == pytest.approx(1.0, abs=1e-12)
    assert r.window_7d.post_mean == pytest.approx(5.0, abs=1e-12)
    assert r.window_7d.lift == pytest.approx(4.0, abs=1e-12)
    assert r.window_7d.n_post == 6  # the inf inside the 7-day post span is dropped
