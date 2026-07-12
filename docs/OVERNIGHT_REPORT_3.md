# Overnight Report 3 — Prospective Prediction Loop Foundations (epic #6)

Date: 2026-07-11 (overnight). Branch: `spec/prospective-foundations` (from `main@620ee96`).
Spec: issues #6 (epic) + #7–#11. Design: `docs/designs/prospective-prediction-loop.md`.

**Result: ALL 5 CHILDREN BUILT AND GATED.** One PR delivers the full Foundations
tranche: schema, verdict engine, seed, priors, and the restructured Actions &
Decisions tab. Final gates: **1110 pytest** (engine + RLS isolation + resolve E2E),
**245 lib tests**, `tsc` clean, `next build` clean, live browser QA in both DB and
seed modes.

> Note on the run itself: the spawned `claude -p` night agent died on a session
> limit ~2 minutes in, after drafting #7/#8 files (ungated). The interactive
> session took over: verified every interface the draft assumed against the real
> code, fixed one wrong test expectation, then built #11 → #9 → #10 in dependency
> order with per-child gates.

## Per-child status

| Child | Status | Commit | Evidence |
|---|---|---|---|
| #7 schema | DONE | `302d0b8` | 5 tables + RLS (scope resolvers mirror `metric_scope()`) + explicit grants + append-only guards; `actions.source` +'jira' (constraint name resolved from catalog); isolation gate extended to all 5 tables, 0 leaks |
| #8 verdict engine | DONE | `8c05dcf` | 8-state machine + sign-primary/in-CI scoring in native space against the exact ITS pre-window mean; GATHERING auto-extends; `LeverConflictError` before any write; 26 tests incl. live E2E; CLI runner mirrors `run_demo.py` |
| #11 seed | DONE | `d887b7e` | All 6 target verdicts produced by the REAL verdict machine over seeded data (CONFIRMED 13.5% in-CI / REFUTED / DIRECTION_CONFIRMED ~2x + revision / INCONCLUSIVE via new organic churn probe #8290 / GATHERING auto-extended / VOIDED via unshipped #8440); idempotent re-run PASS; TS seed tells the same story |
| #9 priors | DONE | `1adf911` | Pure `computePriors` + RLS-scoped class query; REFUTED+INCONCLUSIVE included (survivorship test), belief-weighted, honest nulls; live contract check: ARR class = 3 resolved tuples |
| #10 UI | DONE | `fef389e` | Decisions-first tab; capture flow (elicit-not-assert structural — magnitude never pre-filled); lever propose/confirm; revisions require reason; caveat-first 8-verdict readout; deep-link → parent decision; live QA round-trip verified in Postgres |

## Deviations from spec (all documented in commits)

1. **`resolution_tuple` jsonb column on `predictions`** (not in the spec's SQL
   sketch) — the memory tuple needed a home; the doc's "memory lives in the stored
   tuple" implied it. Priors read it.
2. **Test-expectation fix in the dead agent's draft:** `resolve_due_predictions`
   excludes terminal rows at the SQL scan (`resolved_at is null`) rather than
   returning `SKIPPED_ALREADY_RESOLVED` rows; direct single-prediction re-run still
   reports the skip.
3. **verify.ts stale block replaced:** the old "Actions Shipped / Gathering Data /
   Confident Readouts" assertions referenced labels removed in UI-v3 (would crash
   at runtime); now asserts the Improvement-Rate figure `getAggregatedImpact()`
   actually serves. Action count assertion 10 → 12 (churn probe + unshipped lever).
4. **`Action.shippedAt` is now `string | null`** (the VOIDED lever never shipped);
   all consumers null-guarded. `lib/summary` untouched (golden baseline intact).
5. **LLM lever proposal deferred behind the seam** (deterministic primary-metric
   heuristic tonight) — mirrors `lib/summary`'s off-by-default LLM polish; no
   ANTHROPIC key needed in the worktree.

## Open items for the morning

- **Review + merge the PR** (`spec/prospective-foundations` → `main`). CI will
  re-run everything against a fresh Supabase.
- The **epic #6 stays open** until merge; children can be closed as the PR lands.
- `git worktree remove ../worktrees/prospective-foundations-14593` after merge.
- Next tranche gates unchanged: T2 connector + T3 drift detector wait on the
  design-partner mechanism-mapping test.
- Deferred nits: `resolved 2026-07-11` renders wall-clock resolution timestamps
  against the 2025 demo data (cosmetic); the dev "Resolve now" needs
  `CAUSENT_ENGINE_PYTHON` when the venv isn't at `engine/.venv`.

## How to run it

```bash
supabase start && supabase db reset          # applies the new migration
cd engine && .venv/bin/python -m pytest -q   # 1110 tests
.venv/bin/python persistence/seed_demo.py    # seeds + resolves all 6 verdicts
.venv/bin/python persistence/run_resolution.py --today 2025-05-23  # manual sweep
npm test && npx next build                   # 245 lib tests + build
```
