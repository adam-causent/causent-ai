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

from causal.batch_readout import batch_readout, bh_fdr
from causal.before_after_14d import before_after_14d
from causal.belief_direction import belief_direction
from causal.its_readout import its_readout
from causal.placebo_in_time import placebo_in_time
from causal.types import Belief, Series


def _expected_belief(its_list, placebos, i, q=0.05):
    """Reproduce batch_readout's belief for action i: the placebo-gated ITS
    projection, demoted from 1.0 to 0.5 if it fails BH-FDR across the family."""
    belief = belief_direction(its_list[i], placebos[i])
    discoveries = bh_fdr([r.p_value for r in its_list], q)
    if belief.belief_score == 1.0 and i not in discoveries:
        return Belief(0.5, "INCONCLUSIVE")
    return belief

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

    views = [Series(series.dates, series.values, split) for _, split in splits]
    its_list = [its_readout(v) for v in views]
    placebos = [placebo_in_time(v, its) for v, its in zip(views, its_list)]
    for i, ((ref, split), row) in enumerate(zip(splits, rows)):
        assert row.its == its_list[i]
        assert row.before_after == before_after_14d(views[i])
        assert row.placebo == placebos[i]
        # ITS-authoritative, placebo-gated, then BH-FDR across the three actions.
        assert row.belief == _expected_belief(its_list, placebos, i)


# ---------- adversarial: belief follows ITS, never the naive cross-check ----------

def test_belief_keys_off_its_not_before_after():
    # Noise around a true-zero step: ITS CI straddles 0 -> 0.5/INCONCLUSIVE. The
    # naive before/after may report a nonzero point estimate, but belief must ignore it.
    series = _stepped(40, 40, 0.0, noise=1.0, seed=11)
    [row] = batch_readout(series, [("pr", 40)])

    assert row.its.status == "OK" and row.its.direction == "INCONCLUSIVE"
    assert row.belief.belief_score == 0.5
    assert row.belief == belief_direction(row.its, row.placebo)
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

    # flat metric on its own: DEGENERATE (no variance) -> belief None (UNKNOWN, not 0.0)
    flat = Series(_BASE + np.arange(60), np.full(60, 7.0), split=30)
    [row] = batch_readout(flat, [("flat", 30)])
    assert row.its.status == "DEGENERATE"
    assert row.belief.belief_score is None
    assert row.belief.direction == "INCONCLUSIVE"
    assert row.belief.reason == "DEGENERATE"


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


# ---------- placebo GATE: a firing placebo flips a significant edge to 0.0 ----------

def test_placebo_fired_flips_a_significant_edge_to_zero():
    # A genuinely significant real step (would be belief 1.0) but with a SPURIOUS
    # jump planted at the placebo midpoint: the placebo fires, so the causal claim is
    # unverified and belief collapses to 0.0 / PLACEBO, direction nuked. End-to-end
    # proof that falsification gates belief, not just the pure C8 mapping.
    n = 90
    dates = _BASE + np.arange(n)
    vals = 5.0 + 0.3 * np.arange(n)
    vals[30:] += 7.0   # spurious pre-period jump at the placebo midpoint -> fires
    vals[60:] += 8.0   # real intervention effect at the split
    [row] = batch_readout(Series(dates, vals, split=60), [("pr", 60)])

    assert row.its.status == "OK" and row.its.direction == "POSITIVE"  # C4: strong edge
    assert row.placebo.fired is True                                   # C6 falsifies it
    assert row.belief.belief_score == 0.0
    assert row.belief.direction == "INCONCLUSIVE"
    assert row.belief.reason == "PLACEBO"


# ---------- multiple-comparison control: BH-FDR removes false edges ----------

def test_bh_fdr_matches_textbook_step_up():
    # Classic BH: with m=10, the largest rank r whose p_(r) <= (r/10)*0.05 is r=2
    # (0.008 <= 0.010), so exactly the two smallest p-values are discoveries.
    ps = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.5]
    assert bh_fdr(ps, 0.05) == {0, 1}
    assert bh_fdr([None, None], 0.05) == set()          # nothing tested
    assert bh_fdr([0.2, 0.3, 0.9], 0.05) == set()       # none survive


def test_fdr_demotes_false_edges_across_a_metric_family():
    # A pure-null metric (no real step anywhere) fanned out to many actions. By chance
    # some per-action CIs exclude zero (nominal false edges). BH-FDR across the family
    # must strip them: far fewer — here zero — actions keep belief 1.0. Deterministic
    # (fixed seed), so the counts are exact.
    rng = np.random.default_rng(0)
    n = 400
    dates = _BASE + np.arange(n)
    vals = 100.0 + 0.05 * np.arange(n) + rng.normal(0.0, 3.0, n)   # trend + noise, no step
    series = Series(dates, vals, split=200)
    splits = [(f"a{i}", s) for i, s in enumerate(range(30, 371, 10))]  # 35 OK actions

    rows = batch_readout(series, splits)
    oks = [r for r in rows if r.its.status == "OK"]
    nominal_false = [r for r in oks if r.its.direction != "INCONCLUSIVE"]  # CI excludes 0
    fdr_edges = [r for r in oks if r.belief.belief_score == 1.0]
    demoted = [r for r in nominal_false if r.belief.belief_score == 0.5]

    assert len(nominal_false) >= 2          # the uncorrected method would draw ~3 edges
    assert len(fdr_edges) == 0              # BH-FDR removes every false edge here
    assert len(demoted) >= 1                # demoted 1.0 -> 0.5 / INCONCLUSIVE
    assert all(r.belief.direction == "INCONCLUSIVE" for r in demoted)
