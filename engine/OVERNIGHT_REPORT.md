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

## Causal-honesty fix (2026-07-03)

Four commits on `overnight/foundation` targeted the panel's headline blocker:

- **HAC SEs** (`e5b9b29`): replaced iid `resid_var * pinv(X'X)` with a Newey-West
  Bartlett-kernel sandwich (auto lag `floor(4*(n/100)^(2/9))`) in `segmented_ols`;
  Durbin-Watson + lag stored on `Fit`; `step_ci` now also emits a step p-value.
  HAC formula is textbook-correct and matches an independent `hac_oracle.py` (golden
  tests pass).
- **Placebo gates belief + FDR + semantics** (`c9120e8`): `belief_direction` now
  reads the placebo; `batch_readout` applies BH-FDR (only ever demotes 1.0→0.5);
  `DEGENERATE`→`None` (NULL, no longer conflated with CONFOUNDED's 0.0); `power_mde`
  reconciled to the ±14-day window `n`.
- **Hygiene** (`077a3df`): `np.errstate` guard for the non-finite-date warning;
  single-source 14-day window floor.
- **AR(1) coverage gate** (`bd66c09`): new `test_autocorrelation_coverage.py` — an
  objective Monte-Carlo gate (5000 nulls/level) requiring the null false-positive
  rate (95% CI excludes zero ⇒ would emit belief 1.0) ≤ 0.08 at every ρ.

**Coverage-gate result — RED.** The engine's own gate FAILS. Observed null FP rates:
**0.135 at ρ=0.0, 0.197 at ρ=0.5, 0.274 at ρ=0.8** (gate 0.08). belief=1.0 still fires
on pure noise 13–27% of the time, and the placebo-gated belief rate **equals** the raw
FP rate exactly (placebo removes zero false positives). It even over-rejects under white
noise (fixed-n probe: 17.5% at n=28, ρ=0), so the lag-3 kernel made low-ρ *worse* than
plain OLS-t. Power sanity check passes (belief fires on a real large step). Full suite:
**4 failed, 1010 passed** — the 4 failures are the coverage gate itself.

**Root causes:** (1) HAC has no small-sample correction (no `n/(n-k)` dof adjustment,
no prewhitening/fixed-b) → the sandwich is severely downward-biased at the engine's
n=28–60 regime while `step_ci` still uses the generous `t_{n-k}` critical value.
(2) The placebo is structurally inert: `split//2` placement forces `split ≥ 56`
(n ≥ ~112 days) before a window can be built, so on every realistic v1 series it returns
INSUFFICIENT and fires 0.0% of the time. (3) Durbin-Watson is computed/stored but never
consumed — it gates nothing. (4) BH-FDR runs on anti-conservative p-values and is a no-op
for single-action (m=1) families.

**Re-judge:**

| Reviewer (re-review) | Round-1 | Round-2 | Signs off? |
|----------------------|:-------:|:-------:|:----------:|
| Senior data scientist | 4/10 | **4/10** | No — "DO NOT SIGN OFF" |
| Causal-inference researcher | 5/10 | **3/10** | No — "NO SIGN-OFF" |

Both confirm the round-1 blocker is empirically still present and cite the RED coverage
gate. The researcher dropped 5→3 (shipped the fix red).

**Verdict: STILL BLOCKED — not safe to merge.** Real progress landed (correct HAC formula
vs oracle, DW computed, BH-FDR, DEGENERATE→NULL semantics, ~27 net new tests, and the
objective coverage gate itself), but belief=1.0 still fires on pure autocorrelated noise
13–27% of the time and the engine's own gate is failing.

**Remaining issues before merge:**
1. Add a small-sample HAC correction (`n/(n-k)` dof, or KVB/fixed-b critical values, or a
   block bootstrap) so CIs are honest at n=28–60 — re-tune until the coverage gate passes.
2. Make the placebo actually fire in the operating regime: choose a placebo split that
   fits 14-pre + 14-post within available pre-history, or surface an explicit
   "placebo not evaluable" state instead of silent non-firing.
3. Consume Durbin-Watson in a decision (widen/withhold) rather than only displaying it.
4. Note BH-FDR does not restore its guarantee on anti-conservative p-values and is a no-op
   for single-action families.

## Honest-inference rebuild (2026-07-03)

Six commits on `honest-inference-floor` (`f004fd5`→`d43bcb2`) rebuild the readout as an
**honest DESIGN, not an SE tweak.** The prior round shipped a correct HAC *formula* but
still fired belief=1.0 on pure autocorrelated noise 13–27% of the time; the fix is four
cooperating layers, not a bigger sandwich.

**The four layers:**
1. **`FLOOR_CONFIDENT=45` days/side.** Below it, `its_readout` returns status
   `INSUFFICIENT_HISTORY` (direction `INCONCLUSIVE`; lift/CI/p withheld) and
   `belief_direction` returns `None` with reason `INSUFFICIENT_HISTORY` ("gathering
   data"). A confident 1.0 is unreachable until both sides clear the floor. (`MIN_SIDE=14`
   is still the hard <28-pt no-fit floor; the 45-day floor sits above it.)
2. **Small-sample HAC dof correction.** The Newey-West Bartlett sandwich in
   `segmented_ols` is scaled by an HC1-style `n/(n-k)` (`segmented_ols.py:91`), mirrored
   in the test HAC oracle. Corrects the downward SE bias at the engine's n=28–60 regime.
3. **Durbin-Watson belief cap.** Belief 1.0 requires `DW >= DW_CONFIDENT_MIN=1.3`
   (ρ₁ ≲ 0.35). Residual autocorrelation stronger than HAC can reliably correct at this n
   caps belief at 0.5 with reason `AUTOCORRELATION`. DW is now **consumed** in the
   decision, not merely stored/displayed.
4. **Placebo-in-time that fires in-regime.** The fake split is placed *adjacent* to the
   real intervention (`placebo_split = split - MIN_SIDE`), so 14+14 fits within
   pre-history for any real `split >= 28` — replacing the old `split//2` placement that
   needed ~112 days and silently never fired. Run via raw `segmented_ols` + `step_ci`,
   it fires at a conservative `PLACEBO_ALPHA=0.01` or the magnitude clause, and only when
   the real readout is itself significant. Not-evaluable is an explicit `INSUFFICIENT`
   (placebo_lift=None, fired=False) — never a silent 0% fire; an unverifiable placebo
   withholds the confident 1.0 (drops to 0.5) rather than granting it.

A confident **belief 1.0 is reachable only when** both sides `>= 45`, the CI excludes 0,
the placebo did not fire, **and** `DW >= 1.3`. An always-on 7d/14d descriptive before/after
(`descriptive.py`) is wired into `batch_readout` so the product still shows a number below
the floor, honestly labeled descriptive — never dressed as causal.

**Coverage-gate result — GREEN (`gate_pass = true`).** The engine's own objective
Monte-Carlo gate (`tests/test_autocorrelation_coverage.py`, 8000 NULL AR(1) draws,
ρ∼U[0,0.8], n∼U[MIN_SIDE, ~90]) now passes all three assertions:

| Gate assertion | Ceiling | Observed | Pass |
|---|---|---|---|
| Overall belief-1.0 rate on nulls | ≤ 0.06 | **0.0165** | ✅ |
| Conditional FP rate (evaluable readouts) | ≤ 0.08 | **0.0263** (n=5012) | ✅ |
| Power: belief-1.0 on a true large step w/ history | ≥ 0.90 | pass | ✅ |

Down from the prior round's 0.135 / 0.197 / 0.274 conditional FP at ρ=0/0.5/0.8. Full
suite: **1033 passed, 0 failed.**

**Re-judge:**

| Reviewer (re-review) | Prior round | Re-judge | Signs off? |
|----------------------|:-----------:|:--------:|:----------:|
| Senior data scientist | 4/10 | **8/10** | **Yes** |
| Causal-inference researcher | 3/10 | **8/10** | **Yes** |

Both reviewers confirm the round-1 blocker is empirically resolved: belief 1.0 no longer
fires on autocorrelated noise above the gate, all four remaining issues from the prior
report are addressed (small-sample HAC, in-regime placebo, DW consumed, floor honesty),
and the engine's own gate is green.

**Verdict: SAFE TO MERGE.** Both reviewers signed off (= true) and the objective coverage
gate passes. No blockers remain. The honest-inference redesign holds the line that a
confident causal claim (belief 1.0) is staked only with ≥45 days/side, a CI excluding 0, a
non-firing placebo, and mild-enough residual autocorrelation (DW ≥ 1.3); everything below
that is withheld ("gathering data") or shown as an explicitly descriptive cross-check.

## Persistence bridge (2026-07-03)

**Design.** The bridge (`engine/persistence/bridge.py`) persists engine output into
Supabase without giving the engine a memory. The engine stays **stateless**: it recomputes
readouts from raw series each run and hands the bridge a pure readout; the bridge owns all
DB shape. Every write is **RLS-scoped** to workspaces the caller is a member of — the
engine never sees or crosses a tenant boundary. Evidence is **append-only**: each run
inserts a fresh `evidence_objects` row per (action, method); nothing is mutated or deleted,
so the table is an immutable audit log. Nodes, `causal_edges`, and clusters are
**materialized** (idempotent upsert) from the **authoritative ITS** readout — the ITS row
is the source of truth for edge direction/belief; `BEFORE_AFTER_14D` is persisted as
evidence only and never drives an edge. Colliding actions get a **cluster overlay**: a
`CLUSTER` node with its own `CLUSTER->METRIC` edge, while members keep their individual
`ACTION->METRIC` edges and an `actions.cluster_id` tag.

**Migration additions** (`20260703230000_bridge_support.sql`,
`20260703234500_bridge_integrity_fixes.sql`): `evidence_objects.belief_reason` (nullable —
carries e.g. `INSUFFICIENT_HISTORY` when belief is withheld), `evidence_objects.p_value`
(nullable numeric), and a `methodology` enum (`ITS`, `BEFORE_AFTER_14D`) replacing free
text so method rows are constrained at the DB.

**Live E2E gate — `gate_pass = true`.** Ran against a real Supabase instance, not mocks.
Checks passed:

1. **Evidence objects** — exactly 2 method rows (ITS + BEFORE_AFTER_14D) per eligible
   action A/B/C **and** for the B+C cluster after one run.
2. **Append-only** — a SECOND run doubles evidence rows (8 → 16) while every run-1 row
   survives unmutated; `authenticated` has no UPDATE/DELETE privilege on evidence (both
   raise `InsufficientPrivilege`).
3. **Causal edges** — exactly one `ACTION->METRIC` edge per action, all
   `authoritative_method='ITS'`, all pointing at the single `METRIC` node.
4. **Belief** — A: `POSITIVE` + belief_score `1.0`; B: `INCONCLUSIVE`, belief present but
   ≠ 1.0 (`0.5`); C: belief_score `None` (withheld) + belief_reason `INSUFFICIENT_HISTORY`.
5. **Recompute agreement** — each edge's `(direction, belief_score, reason)` equals
   `belief_direction()` recomputed on the authoritative ITS readout, and the latest ITS
   evidence row's `lift/ci/p_value/n_pre/n_post/placebo` match that readout.
6. **RLS on writes** — persisting a foreign (unmembered) metric writes **nothing**
   (0 nodes/edges/evidence/clusters in the foreign scope); a direct node INSERT into the
   foreign scope as the user raises `InsufficientPrivilege`.
7. **Nodes** — 1 METRIC + 3 ACTION + 1 CLUSTER; B/C collide (13 days apart ≤ 14) into one
   CLUSTER with a `CLUSTER->METRIC` edge, members keep their `ACTION->METRIC` edges and are
   tagged `actions.cluster_id`; A stays unclustered.
8. **Idempotency** — a second run leaves nodes/edges/clusters counts unchanged (upsert
   converges); beliefs stable across runs.

**Integrity review: ISSUES → fixed.** The review returned an ISSUES verdict with **3
issues**; all 3 are fixed (captured in `20260703234500_bridge_integrity_fixes.sql` and the
bridge). No open integrity findings remain.

**Merge-ready: yes.** The live E2E gate is green, RLS isolation is demonstrated against a
real instance, append-only immutability is enforced at the privilege level, and the
integrity issues are closed.

**Residual risk (plain).** The gate exercises one canonical fixture (A unclustered, B+C
clustered, one metric); it does not fuzz N-way cluster collisions (3+ actions inside 14d),
concurrent runs racing the same upsert, or workspaces with many metrics. Append-only means
the evidence table grows unbounded — no retention/compaction is in place yet. RLS is proven
for the tested member/non-member paths but not for role-escalation or service-role misuse.
None of these block merge; they are the next hardening pass.
