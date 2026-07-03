# Overnight Build Report — Causal Engine

**Suite:** `982 passed, 1 warning` (`cd engine && .venv/bin/python -m pytest -q`, ~2.9s).
The one warning is a known non-blocking `RuntimeWarning` from `segmented_ols.py:39` on
non-finite dates (result is correctly DEGENERATE). All 9 components impl PASS; two had
adversarial defects, both fixed.

## Components

| # | Component | Impl | Adversarial | Achieved tolerance |
|---|-----------|------|-------------|--------------------|
| C1 | `t_ppf` | PASS | SOLID | abs ≤ ~3e-7 vs scipy over p∈[1e-6, 1−1e-6]; ~1e-9 (abs/rel) on the golden grid; deep-tail (p~1e-9) rel error grows to ~3e-7. |
| C2 | `segmented_ols` | PASS | SOLID | Noise-free golden recovery of all coefficients: max abs error ~1.6e-14–2.3e-14 (design cond ~120–900). Tests assert abs=1e-6; target easily met. |
| C3 | `step_ci` | PASS | SOLID | ~1.4e-14 abs vs scipy oracle (well below 1e-6). t_ppf critical-value chain + covariance combine cleanly in pure numpy. |
| C4 | `its_readout` | PASS | SOLID | CI bounds + lift match scipy oracle to rel/abs 1e-9; noiseless known-truth lift recovery to abs 1e-6. No added error over C2/C3 pass-through. |
| C5 | `before_after_14d` | PASS | DEFECTS (fixed) | CI agrees with scipy Welch oracle to ~1e-14 abs worst-case over 2000 randomized cases. Tests assert rel/abs 1e-9. |
| C6 | `placebo_in_time` | PASS | SOLID | 1e-6 noise-free golden recovery; 1e-9 vs scipy oracle under noise. |
| C7 | `power_mde` | PASS | DEFECTS (fixed) | rel=1e-9 vs scipy oracle (main/noisy paths + analytic known-truth MDE); rel=1e-8 on df=1 heavy-tail edge (n_pre=3). Inside 1e-6. |
| C8 | `belief_direction` | PASS | SOLID | Exact — pure discrete mapping to canonical constants (None/0.0/0.5/1.0); bit-exact, `==` assertions. Numeric tolerance N/A. |
| C9 | `batch_readout` | PASS | SOLID | 0.0 (exact) for orchestration equality; 1e-9 for planted-step recovery vs scipy oracle. |

## Panel review

| Reviewer | Score | Verdict |
|----------|:-----:|---------|
| Staff software engineer | 8/10 | Ships with minor changes — clean, honest, well-typed pure-numpy engine. Resolve DEGENERATE→0.0 mapping and the numpy warning before sign-off. |
| Senior data scientist | 4/10 | Individual math excellent, but ITS CIs ignore autocorrelation → belief 1.0 on noise ~half the time. Cannot ship as an honest causal engine yet. |
| Causal-inference researcher | 5/10 | Strong scaffolding, but overclaims: OLS CIs on autocorrelated daily data + a placebo that never gates belief mean headline belief=1.0 can't be trusted. No causal sign-off as-is. |
| Director of product | 8/10 | Honest, disciplined, dead-on the wedge. One statistical-honesty question (E1 power proxy) from a clean sign-off. |

### Key issues raised

**Statistical validity (data scientist + researcher — the blocker):**
- **No autocorrelation correction.** `segmented_ols` computes CIs as `resid_var * pinv(X'X)` assuming iid residuals. Daily business metrics are serially correlated → SEs understated, CIs too narrow. Under AR(1) ρ=0.5 coverage falls to 0.76 (FP 0.24); ρ=0.8 to 0.50 (FP 0.50). "CI-excludes-zero → belief 1.0" assigns confident causal claims to pure noise ~50% of the time; even with the placebo gate, 21% of null AR(0.8) runs emit belief=1.0 without the placebo firing. Needs HAC/Newey-West SEs or prewhitening (Wagner et al. 2002 recipe: DW check + Newey-West/Prais-Winsten).
- **Placebo doesn't gate belief.** `placebo_in_time` computes `fired` and `batch_readout` attaches it, but `belief_direction(its)` is a pure function of the ITS CI and never reads the placebo. Falsification is computed and displayed but decorative. The decision-graph belief table has no placebo row.
- **Placebo is a single midpoint split**, not a permutation distribution. Only `split//2` is tested. The `|placebo_lift| ≥ 0.5*|real_lift|` firing rule uses an arbitrary 0.5 threshold — stays silent when a placebo recovers up to 49% of a large real effect from noise (the dangerous case).
- **No multiple-comparison control.** `batch_readout` fans one metric across up to 200 actions, each tested at α=0.05, each eligible for belief 1.0 → ~10 expected false-positive edges per fully-loaded metric. No Bonferroni/FDR.
- **Single-group ITS, no control series, no seasonality.** Level + trend + step (+ optional post-slope); the step coefficient absorbs co-temporal shocks, regression to the mean, and weekly seasonality. `causal_edges` naming + binary belief 1.0 (p=0.049 scores identical to p=1e-9) overstates identification.
- **Covariance conditioning.** `cov = resid_var * pinv(X.T @ X)` squares the condition number; the `_COND_MAX=1e10` gate on `cond(X)` is ~3 orders too loose to protect the CI-width path (cov already ~95% wrong by cond(X)~5e7). Fix: derive cov from the lstsq SVD/QR, or tighten `_COND_MAX` to ~1e7. (Not triggerable with clean consecutive daily ordinals.)
- **Model misspecification 14≤side<28:** `post_slope` column dropped, so a true post-intervention slope change biases the step estimate; readout doesn't caveat the bias.
- **`power_mde` uses central-t** `t_ppf(power, df)` for the power term instead of noncentral-t — standard normal-approx MDE, slightly optimistic. Acceptable only as a labeled proxy.

**Correctness / hygiene (staff engineer):**
- `belief_direction.py:26` maps DEGENERATE → belief 0.0 (identical to CONFOUNDED), overclaiming: a rank-deficient solve is "unknown" (NULL-like), not "confident no effect". The decision-graph table has no DEGENERATE row to justify 0.0. Needs a documented decision.
- `segmented_ols.py:39` does `t - t.mean()` before the finiteness guard at line 45 → the suite's one RuntimeWarning. Move `np.isfinite` ahead of the arithmetic (or guard with `np.errstate`).
- **Redundant compute (also raised by product):** the real ITS solve runs up to 3× per action — once in `batch_readout`, then twice inside `placebo_in_time` (`its_readout(series)` for real_lift + the placebo split). Pass the computed `ITSResult` into `placebo_in_time`.
- `placebo_in_time.py:39-41` can "fire" via `ci_excludes_zero` even when the real readout is not OK (real_lift is None) — harmless but incoherent.

**Scope / product (director of product):**
- **E1 `power_mde` may OVERSTATE detectability** (top honesty risk): MDE uses full pre-history `n_pre` (`sqrt(var*(2/n_pre))` at `power_mde.py:59`), but the ITS readout it gates only ever uses ~14 points/side. As history grows, MDE shrinks and the "underpowered" warning clears even though the real 14/14-window readout still couldn't detect the effect. Reconcile `n` with the spec's ±14-day windows.
- **CONFOUNDED is advertised but never produced.** `belief_direction` maps CONFOUNDED→0.0 and the decision-graph + rendering contract promise a distinct "confounded / hatched grey" state, but nothing in the built engine emits it (cluster resolution unbuilt). The UI/schema will promise a live v1 state the pipeline never returns.
- **DRY:** the 14-day floor is redefined in three files (`its_readout._MIN_SIDE`, `before_after_14d._WINDOW`, `placebo_in_time._WINDOW`) against the one-source-of-truth rule.

## What needs a human (morning)

1. **No FAIL / NO-fix components.** All 9 impl PASS; C5 and C7 adversarial defects were both fixed. Nothing is blocked on a broken component.
2. **T0 Python-vs-TS decision — C1 says TS is viable.** `t_ppf` hits ~3e-7 abs (≈1e-9 on the golden grid) in pure numpy with **no scipy in the shipped path**. Since the whole statistics stack (t-quantile, Welch, CIs) is scipy-free and matches the oracle to 1e-14–1e-9, there is no numerical blocker to a TypeScript port — the only cost is reimplementing `t_ppf`/`erf`-class functions to that same tolerance. Deep-tail (p<1e-6) rel error to ~3e-7 is the one thing a TS port must match; it's inside the 1e-6 target but is the tightest spot. **Decision:** greenlight TS T0 unless we need p far into the tails.
3. **Panel < 7 = the causal-honesty blocker (data scientist 4, researcher 5).** Both independently flag the same thing: OLS CIs ignore autocorrelation, so belief=1.0 fires on pure noise ~50% under AR(1) ρ=0.8, and the placebo never gates belief. This voids the headline readout for exactly the autocorrelated daily metrics the product targets. **This is the single most important morning decision:** add HAC/Newey-West SEs (or prewhitening) + make the placebo actually gate belief before any customer sees a belief score. Everything else is secondary.
4. **Product/design calls needed:**
   - **CONFOUNDED state:** confirm the cluster-overlay path that emits CONFOUNDED is genuinely next, not silently dropped — the UI/schema is about to promise a v1 state the engine never returns.
   - **DEGENERATE → belief 0.0:** decide whether a degenerate solve should read as "no effect" (0.0) or "unknown" (NULL/None). Currently indistinguishable from CONFOUNDED.
   - **E1 power_mde n:** reconcile `n_pre` with the ±14-day window before the "underpowered" warning ships, or it will clear too early and undercut the "estimated, not proven" promise.
   - **Multiple-comparison policy:** decide FDR/Bonferroni (or an explicit "no correction, exploratory" stance) before fanning one metric across 200 actions in the UI.
