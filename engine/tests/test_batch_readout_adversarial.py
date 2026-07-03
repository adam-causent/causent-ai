"""Adversarial tests for C9 batch_readout — written by a reviewer who did NOT
write the engine, aiming to BREAK it.

Attack surface (per the C9 contract):
  * action-count cap: behaviour exactly AT max_actions vs one OVER it, plus the
    degenerate max_actions in {0, negative} and the "raise before any compute" claim;
  * empty batch -> [] exactly (not None, not a one-element list);
  * overlapping / identical / adjacent per-action windows must not corrupt each
    other, and the shared input Series must not be mutated;
  * numeric fidelity at the exact structural boundaries of C2's design (the 14/14
    minimum-viable readout and the 27/27 -> 28/28 post-slope column transition),
    with scipy as an INDEPENDENT least-squares + t-interval oracle;
  * belief stays ITS-authoritative even when the naive cross-check disagrees.

scipy is a TEST-ONLY oracle; the shipped engine is numpy-only.
"""

import numpy as np
import pytest
import scipy.linalg as sla
from scipy import stats

from causal.batch_readout import batch_readout, bh_fdr
from causal.before_after_14d import before_after_14d
from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import Belief, Series

_BASE = 738000


def _expected_belief(its_list, placebos, i, q=0.05):
    """Reproduce batch_readout's belief: placebo-gated ITS projection, demoted from
    1.0 to 0.5 when the action fails BH-FDR across the family of per-metric tests."""
    belief = belief_direction(its_list[i], placebos[i])
    discoveries = bh_fdr([r.p_value for r in its_list], q)
    if belief.belief_score == 1.0 and i not in discoveries:
        return Belief(0.5, "INCONCLUSIVE")
    return belief


def _stepped(n_pre, n_post, step, slope=0.3, level=5.0, noise=None, seed=0):
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    vals = level + slope * np.arange(n).astype(np.float64)
    vals[n_pre:] += step
    if noise is not None:
        vals = vals + np.random.default_rng(seed).normal(0.0, noise, n)
    return Series(dates, vals, split=n_pre)


def _design(dates, split, n):
    """Reproduce C2's design matrix EXACTLY (independent of the engine code)."""
    t = dates.astype(np.float64)
    post = (np.arange(n) >= split).astype(np.float64)
    cols = [np.ones(n), t - t.mean(), post]
    if split >= 28 and n - split >= 28:
        cols.append(np.where(post > 0, t - t[split], 0.0))
    return np.column_stack(cols)


def _oracle_step(series, split):
    """Independent step coefficient via scipy.linalg.lstsq (not numpy.lstsq)."""
    y = series.values.astype(np.float64)
    n = y.size
    X = _design(series.dates, split, n)
    beta, *_ = sla.lstsq(X, y)
    return float(beta[2])


def _oracle_ci_excludes_zero(series, split, alpha=0.05):
    """Independent 95% t-interval on the step coefficient; does it exclude 0?"""
    y = series.values.astype(np.float64)
    n = y.size
    X = _design(series.dates, split, n)
    beta, *_ = sla.lstsq(X, y)
    resid = y - X @ beta
    dof = n - X.shape[1]
    s2 = float(resid @ resid / dof)
    se = float(np.sqrt(s2 * sla.inv(X.T @ X)[2, 2]))
    tcrit = float(stats.t.ppf(1.0 - alpha / 2.0, dof))
    step = float(beta[2])
    return abs(step) > tcrit * se, step


# ======================================================================
# CAP BOUNDARY — the headline attack: == vs > max_actions
# ======================================================================

def test_cap_exactly_at_limit_computes_all():
    series = _stepped(20, 20, 3.0)
    splits = [(f"a{i}", 20) for i in range(7)]
    rows = batch_readout(series, splits, max_actions=7)   # len == cap
    assert len(rows) == 7
    assert [r.action_ref for r in rows] == [f"a{i}" for i in range(7)]


def test_cap_one_over_limit_raises():
    series = _stepped(20, 20, 3.0)
    splits = [(f"a{i}", 20) for i in range(8)]            # len == cap + 1
    with pytest.raises(ValueError, match="exceeds max_actions"):
        batch_readout(series, splits, max_actions=7)


def test_cap_message_reports_both_counts():
    series = _stepped(20, 20, 3.0)
    with pytest.raises(ValueError) as ei:
        batch_readout(series, [("a", 20)] * 5, max_actions=3)
    msg = str(ei.value)
    assert "5" in msg and "3" in msg


def test_cap_raises_before_any_compute():
    # A metric with only NaN values would blow up if any component ran. The cap
    # check must short-circuit first, so we get a clean ValueError, not a crash.
    n = 40
    poison = Series(_BASE + np.arange(n), np.full(n, np.nan), split=20)
    with pytest.raises(ValueError, match="exceeds max_actions"):
        batch_readout(poison, [("x", 20)] * 3, max_actions=2)


def test_cap_zero_allows_only_empty():
    series = _stepped(20, 20, 3.0)
    assert batch_readout(series, [], max_actions=0) == []   # 0 > 0 is False
    with pytest.raises(ValueError, match="exceeds max_actions"):
        batch_readout(series, [("a", 20)], max_actions=0)


def test_default_cap_is_exactly_200():
    series = _stepped(20, 20, 1.0)
    assert len(batch_readout(series, [("a", 20)] * 200)) == 200     # == default
    with pytest.raises(ValueError, match="max_actions=200"):
        batch_readout(series, [("a", 20)] * 201)                    # one over


# ======================================================================
# EMPTY BATCH
# ======================================================================

def test_empty_batch_is_empty_list_not_none():
    out = batch_readout(_stepped(20, 20, 1.0), [])
    assert out == [] and isinstance(out, list) and len(out) == 0


# ======================================================================
# OVERLAPPING / IDENTICAL / ADJACENT WINDOWS — no cross-contamination
# ======================================================================

def test_identical_splits_yield_identical_rows():
    # Same split twice: rows must be byte-identical (no hidden per-iteration state).
    series = _stepped(30, 40, 5.0, noise=1.0, seed=7)
    rows = batch_readout(series, [("dup1", 35), ("dup2", 35)])
    a, b = rows
    assert a.its == b.its
    assert a.before_after == b.before_after
    assert a.placebo == b.placebo
    assert a.belief == b.belief


def test_maximally_overlapping_windows_match_direct_calls():
    # Splits one day apart: their 14d before/after windows overlap by 13 days.
    # Each row must still equal an isolated component call on its own view.
    series = _stepped(40, 40, 6.0, noise=1.2, seed=9)
    splits = [("p", 39), ("q", 40), ("r", 41)]
    rows = batch_readout(series, splits)
    views = [Series(series.dates, series.values, split) for _, split in splits]
    its_list = [its_readout(v) for v in views]
    placebos = [placebo_in_time(v, its) for v, its in zip(views, its_list)]
    for i, ((ref, split), row) in enumerate(zip(splits, rows)):
        assert row.action_ref == ref
        assert row.its == its_list[i]
        assert row.before_after == before_after_14d(views[i])
        assert row.placebo == placebos[i]
        assert row.belief == _expected_belief(its_list, placebos, i)


def test_input_series_is_not_mutated():
    series = _stepped(30, 30, 4.0, noise=0.8, seed=2)
    dates_snap = series.dates.copy()
    vals_snap = series.values.copy()
    batch_readout(series, [("a", 15), ("b", 30), ("c", 45)])
    assert np.array_equal(series.dates, dates_snap)
    assert np.array_equal(series.values, vals_snap)
    assert series.split == 30   # frozen; per-action split must not leak back


def test_order_preserved_with_repeated_refs():
    series = _stepped(30, 40, 5.0)
    splits = [("z", 30), ("a", 30), ("z", 55), ("a", 20)]
    rows = batch_readout(series, splits)
    assert [(r.action_ref) for r in rows] == ["z", "a", "z", "a"]


# ======================================================================
# NUMERIC BOUNDARY — scipy oracle at C2's structural edges
# ======================================================================

def test_min_viable_14_14_boundary_matches_scipy():
    # The exact 14/14 floor: n=28, k=3 (no post-slope). Must fit, not INSUFFICIENT.
    series = _stepped(14, 14, 9.0)
    [row] = batch_readout(series, [("edge", 14)])
    assert row.its.status == "OK"
    assert row.its.lift == pytest.approx(_oracle_step(series, 14), abs=1e-9)
    assert row.its.lift == pytest.approx(9.0, abs=1e-9)


def test_just_below_floor_is_insufficient():
    # 13 on the post side: below the 14-floor -> INSUFFICIENT, belief None.
    series = _stepped(20, 13, 9.0)
    [row] = batch_readout(series, [("edge", 20)])
    assert row.its.status == "INSUFFICIENT"
    assert row.its.lift is None
    assert row.belief.belief_score is None
    assert row.belief.direction == "INCONCLUSIVE"


@pytest.mark.parametrize("n_side,k_expected", [(27, 3), (28, 4)])
def test_post_slope_column_transition_matches_scipy(n_side, k_expected):
    # 27/27 -> k=3, 28/28 -> k=4 (post-slope column added). A pure level shift must
    # be recovered in BOTH designs, exactly matching an independent scipy solve.
    series = _stepped(n_side, n_side, 7.0)
    [row] = batch_readout(series, [("t", n_side)])
    X = _design(series.dates, n_side, 2 * n_side)
    assert X.shape[1] == k_expected
    assert row.its.status == "OK"
    assert row.its.lift == pytest.approx(_oracle_step(series, n_side), abs=1e-8)
    assert row.its.lift == pytest.approx(7.0, abs=1e-8)


@pytest.mark.parametrize("seed", [1, 4, 17, 23, 31])
def test_direction_agrees_with_scipy_under_noise(seed):
    # Independent scipy t-interval decides significance; C4's OK/POSITIVE|NEGATIVE|
    # INCONCLUSIVE verdict surfaced by C9 must agree with it, and the lift must match.
    series = _stepped(45, 45, 5.0, noise=1.0, seed=seed)
    [row] = batch_readout(series, [("pr", 45)])
    excludes_zero, step = _oracle_ci_excludes_zero(series, 45)
    assert row.its.status == "OK"
    assert row.its.lift == pytest.approx(step, abs=1e-8)
    if excludes_zero:
        assert row.its.direction == ("POSITIVE" if step > 0 else "NEGATIVE")
        assert row.belief.belief_score == 1.0
    else:
        assert row.its.direction == "INCONCLUSIVE"
        assert row.belief.belief_score == 0.5


def test_true_null_is_inconclusive_and_scipy_agrees():
    # A genuine zero step under noise: scipy CI must include 0, and belief 0.5.
    series = _stepped(45, 45, 0.0, noise=1.0, seed=42)
    [row] = batch_readout(series, [("null", 45)])
    excludes_zero, _ = _oracle_ci_excludes_zero(series, 45)
    assert not excludes_zero
    assert row.its.direction == "INCONCLUSIVE"
    assert row.belief.belief_score == 0.5


# ======================================================================
# BELIEF STAYS ITS-AUTHORITATIVE
# ======================================================================

def test_belief_is_projection_of_its_only():
    # A pure linear trend with NO level shift: the naive before/after sees a large
    # jump (14 later days sit higher on the ramp), but ITS removes the trend and
    # finds no step. Belief must be the projection of ITS, never the cross-check.
    series = _stepped(45, 45, 0.0, slope=0.5, noise=0.0)
    [row] = batch_readout(series, [("pr", 45)])
    view = Series(series.dates, series.values, 45)
    assert row.belief == belief_direction(its_readout(view), row.placebo)  # ITS-derived
    # the cross-check reports a large positive "lift" from the ramp...
    assert row.before_after.status == "OK"
    assert row.before_after.lift is not None and row.before_after.lift > 5.0
    # ...yet belief did NOT come from it: ITS finds no significant step.
    assert row.its.direction == "INCONCLUSIVE"
    assert row.belief.belief_score == 0.5


def test_mixed_batch_each_row_independent():
    # good (OK) + short (INSUFFICIENT) + flat-slice degenerate, in one call.
    n = 90
    dates = _BASE + np.arange(n)
    vals = 5.0 + 0.3 * np.arange(n).astype(np.float64)
    vals[45:] += 8.0
    series = Series(dates, vals, split=45)

    rows = batch_readout(series, [("good", 45), ("short", 5)])
    good, short = rows
    assert good.its.status == "OK" and good.belief.belief_score == 1.0
    assert good.its.lift == pytest.approx(_oracle_step(series, 45), abs=1e-8)
    assert short.its.status == "INSUFFICIENT"
    assert short.its.lift is None and short.belief.belief_score is None

    flat = Series(_BASE + np.arange(60), np.full(60, 7.0), split=30)
    [frow] = batch_readout(flat, [("flat", 30)])
    assert frow.its.status == "DEGENERATE"
    assert frow.belief.belief_score is None  # UNKNOWN, not "no effect"
    assert frow.belief.direction == "INCONCLUSIVE"
    assert frow.belief.reason == "DEGENERATE"


# ======================================================================
# DEGENERATE PER-ACTION SPLITS DON'T RAISE
# ======================================================================

@pytest.mark.parametrize("bad_split", [0, 1, -5, 200, 79, 80])
def test_out_of_range_and_edge_splits_never_raise(bad_split):
    # split at/near the ends, negative, or past the end must yield a defined row.
    series = _stepped(40, 40, 6.0)   # n = 80
    [row] = batch_readout(series, [("x", bad_split)])
    assert row.action_ref == "x"
    # non-OK statuses must carry a well-formed belief, never a fabricated number.
    assert row.its.status in ("OK", "INSUFFICIENT", "DEGENERATE")
    if row.its.status == "INSUFFICIENT":
        assert row.belief.belief_score is None
    elif row.its.status == "DEGENERATE":
        assert row.belief.belief_score is None  # UNKNOWN, not "no effect"
