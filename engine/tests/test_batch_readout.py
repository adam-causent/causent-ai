"""Golden-data + adversarial tests for C9 batch_readout.

Truth: batch_readout is orchestration — it fans one metric series out into a
per-action ITS/cross-check/placebo/belief row. So (a) on noise-free data each row
recovers a KNOWN planted step (scipy re-derives the same step as an independent
oracle), and (b) each row is bit-identical to calling the components directly on the
same per-action view — C9 does no new math, so exact equality (tol 0.0) is the bar.
The rest pins the contract: input-order fan-out, the max_actions cap, ITS-authoritative
belief, per-action split (NOT series.split), and mixed good/degenerate actions.
scipy is a TEST-ONLY oracle; the shipped engine is numpy-only.
"""

import numpy as np
import pytest
from scipy import stats

from causal.batch_readout import batch_readout
from causal.before_after_14d import before_after_14d
from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import Series

_BASE = 738000  # arbitrary ordinal-day offset; centering absorbs it


def _stepped(n_pre, n_post, step, slope=0.3, level=5.0, noise=None, seed=0):
    """A daily series with a KNOWN level shift of `step` at index n_pre."""
    n = n_pre + n_post
    dates = _BASE + np.arange(n)
    vals = level + slope * np.arange(n)
    vals[n_pre:] += step
    if noise is not None:
        vals = vals + np.random.default_rng(seed).normal(0.0, noise, n)
    return Series(dates, vals, split=n_pre)


def _oracle_step(series, split):
    """Independent OLS step coefficient on the C2 design (scipy solve)."""
    y = series.values.astype(np.float64)
    t = series.dates.astype(np.float64)
    n = y.size
    post = (np.arange(n) >= split).astype(np.float64)
    cols = [np.ones(n), t - t.mean(), post]
    if split >= 28 and n - split >= 28:          # C2 adds a post-slope column
        cols.append(np.where(post > 0, t - t[split], 0.0))
    X = np.column_stack(cols)
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    return float(beta[2])


# ---------- golden: KNOWN planted step recovered per action ----------

@pytest.mark.parametrize("step,direction", [(8.0, "POSITIVE"), (-8.0, "NEGATIVE")])
def test_recovers_known_step(step, direction):
    series = _stepped(40, 40, step)
    [row] = batch_readout(series, [("pr-1", 40)])

    assert row.action_ref == "pr-1"
    assert row.its.status == "OK"
    assert row.its.direction == direction
    assert row.its.lift == pytest.approx(step, abs=1e-9)
    assert row.its.lift == pytest.approx(_oracle_step(series, 40), abs=1e-9)
    assert row.belief.belief_score == 1.0
    assert row.belief.direction == direction


# ---------- golden: bit-identical to the components it orchestrates ----------

def test_rows_equal_direct_component_calls():
    # One shared series, three actions at distinct valid splits. Every field must
    # equal a direct call on the per-action view, EXACTLY (C9 adds no math).
    series = _stepped(30, 60, 6.0, noise=1.5, seed=3)  # 90 points
    splits = [("a", 20), ("b", 45), ("c", 70)]

    rows = batch_readout(series, splits)
    assert [r.action_ref for r in rows] == ["a", "b", "c"]  # input order preserved

    for (ref, split), row in zip(splits, rows):
        view = Series(series.dates, series.values, split)
        its = its_readout(view)
        assert row.its == its
        assert row.before_after == before_after_14d(view)
        assert row.placebo == placebo_in_time(view)
        assert row.belief == belief_direction(its)  # ITS-authoritative


# ---------- adversarial: belief follows ITS, never the naive cross-check ----------

def test_belief_keys_off_its_not_before_after():
    # Noise around a true-zero step: ITS CI straddles 0 -> 0.5/INCONCLUSIVE. The
    # naive before/after may report a nonzero point estimate, but belief must ignore it.
    series = _stepped(40, 40, 0.0, noise=1.0, seed=11)
    [row] = batch_readout(series, [("pr", 40)])

    assert row.its.status == "OK" and row.its.direction == "INCONCLUSIVE"
    assert row.belief.belief_score == 0.5
    assert row.belief == belief_direction(row.its)
    # sanity: the cross-check exists and is descriptive-only, not what belief read
    assert row.before_after.method == "BEFORE_AFTER_14D"


# ---------- adversarial: per-action split, not series.split ----------

def test_uses_action_split_not_series_split():
    # series.split is a bogus 10 (would be INSUFFICIENT); the action asks for 40,
    # where the real step lives. Recovering it proves the view uses the action split.
    series = _stepped(40, 40, 8.0)
    series = Series(series.dates, series.values, split=10)  # poison the series split

    [row] = batch_readout(series, [("pr", 40)])
    assert row.its.status == "OK"
    assert row.its.lift == pytest.approx(8.0, abs=1e-9)


# ---------- boundary: max_actions cap ----------

def test_max_actions_boundary():
    series = _stepped(20, 20, 1.0)
    at_cap = [(f"a{i}", 20) for i in range(3)]
    assert len(batch_readout(series, at_cap, max_actions=3)) == 3   # == cap is OK

    over_cap = at_cap + [("a3", 20)]
    with pytest.raises(ValueError, match="exceeds max_actions"):
        batch_readout(series, over_cap, max_actions=3)


def test_default_cap_is_200():
    series = _stepped(20, 20, 1.0)
    with pytest.raises(ValueError, match="max_actions=200"):
        batch_readout(series, [("a", 20)] * 201)


def test_empty_batch_returns_empty():
    assert batch_readout(_stepped(20, 20, 1.0), []) == []


# ---------- degenerate: bad actions return defined rows, never a raise ----------

def test_mixed_good_and_degenerate_actions():
    # One recoverable action, one too-short (INSUFFICIENT), one on a flat metric slice
    # (DEGENERATE). All three must yield defined rows; the good one is unaffected.
    n = 80
    dates = _BASE + np.arange(n)
    vals = 5.0 + 0.3 * np.arange(n)
    vals[40:] += 8.0
    series = Series(dates, vals, split=40)

    rows = batch_readout(series, [("good", 40), ("short", 5)])
    good, short = rows
    assert good.its.status == "OK" and good.belief.belief_score == 1.0
    assert short.its.status == "INSUFFICIENT"
    assert short.its.lift is None and short.belief.belief_score is None

    # flat metric on its own: DEGENERATE (no variance to explain) -> belief 0.0
    flat = Series(_BASE + np.arange(60), np.full(60, 7.0), split=30)
    [row] = batch_readout(flat, [("flat", 30)])
    assert row.its.status == "DEGENERATE"
    assert row.belief.belief_score == 0.0
    assert row.belief.direction == "INCONCLUSIVE"


# ---------- placebo: clean pre-history does not falsify a real readout ----------

def test_placebo_does_not_fire_on_clean_history():
    # Long clean pre-history + a real step at the split. The placebo split lands in
    # noise-free linear pre-history where nothing shipped, so it must NOT fire.
    series = _stepped(60, 30, 8.0)  # split 60 -> placebo has room to fit
    [row] = batch_readout(series, [("pr", 60)])
    assert row.placebo.status == "OK"
    assert row.placebo.fired is False


# ---------- oracle cross-check under noise (independent scipy t-interval) ----------

def test_direction_matches_scipy_significance_under_noise():
    # A real +6 step under mild noise: scipy's own OLS + t-interval on the step must
    # agree with C4's OK/POSITIVE verdict that batch surfaces.
    series = _stepped(45, 45, 6.0, noise=1.0, seed=5)
    [row] = batch_readout(series, [("pr", 45)])

    step = _oracle_step(series, 45)
    # independent SE via scipy: refit and use residual df t critical value
    y = series.values.astype(np.float64)
    t = series.dates.astype(np.float64)
    n = y.size
    post = (np.arange(n) >= 45).astype(np.float64)
    X = np.column_stack([np.ones(n), t - t.mean(), post,
                         np.where(post > 0, t - t[45], 0.0)])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    dof = n - X.shape[1]
    s2 = float(resid @ resid / dof)
    se = float(np.sqrt(s2 * np.linalg.inv(X.T @ X)[2, 2]))
    tcrit = float(stats.t.ppf(0.975, dof))
    excludes_zero = abs(step) > tcrit * se

    assert excludes_zero and step > 0            # oracle: significant positive
    assert row.its.status == "OK" and row.its.direction == "POSITIVE"
    assert row.its.lift == pytest.approx(step, abs=1e-9)
