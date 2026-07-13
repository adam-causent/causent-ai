# Overnight Report 4 — Cold-Start partial: C1 + C4 + C2 (issues #14, #17, #15)

Date: 2026-07-12 (overnight). Branch: `spec/coldstart-c1-c2-c4` (off `e6d3ad7`).
PR: one PR to `main` — **Closes #14, Closes #17. Progresses #15** (Steps 2-4;
auth integration pending #5). Part of epic #13. **Not merged** (by instruction).

## TL;DR

All three children built, all gates green:

- **#14 (C1 schema)** — `levers` table (+RLS, +grants), `decision_actions.is_lever`
  dropped everywhere (schema AND code), `metrics.source += 'declared'`,
  `resolved_verdict += 'UNMEASURABLE_NO_METRIC'`. DONE — closes with the PR.
- **#17 (C4 resolution)** — resolve.py reads the `levers` table; 1 shipped lever =
  unchanged single-ITS path; >1 shipped lever same metric = cluster overlay
  (single-intervention ITS at the earliest ship, belief on the CLUSTER edge);
  ships spanning > `MAX_CLUSTER_SPAN_DAYS` (28, env-overridable) → `UNRESOLVABLE`;
  all DROPPED/unshipped → `VOIDED`; declared metric with no observations →
  `UNMEASURABLE_NO_METRIC` before any ITS. DONE — closes with the PR.
- **#15 (C2 funnel)** — `/onboarding` Steps 2-4 live behind the agreed dev-session
  seam (`lib/auth/session.ts`): paste → LLM decision card + 2-3 interrogation
  questions → declared metric → prediction commitment → prediction card with
  countdown. Garbage paste falls back to manual entry (verified live). PROGRESSED,
  not closed — Step 1 (auth) is #5; instrumentation + E2E-under-auth remain.

## What shipped, per issue

### #14 — C1 schema (commit `ce9899d`)

- `supabase/migrations/20260712040728_cold_start_levers.sql` — created via
  `supabase migration new` (no hand-picked timestamp). Exactly the issue's SQL;
  both constraint names confirmed against the live catalog before writing
  (`metrics_source_check`, `predictions_resolved_verdict_check` — as guessed).
- Everything that read/wrote `is_lever` moved to `levers` in the same commit so
  the branch is green at every commit: `engine/persistence/resolve.py` (lookup),
  `engine/persistence/seed_demo.py` (seeds one lever per decision; PR #8440 =
  `DETECTED`/unshipped for the VOIDED story), `lib/data/decisions.ts` (reads
  nested `levers(...)`), `app/(dashboard)/actions/server-actions.ts` (lever
  mapping writes a levers row: `SHIPPED` when the action has a ship date, else
  `DETECTED`; provenance token `causent-<uuid>`).
- RLS gate +4 (`engine/tests/test_rls_isolation.py`, 12 → 16): member r/w +
  viewer deny; cross-tenant deny (also added to the every-table isolation sweep);
  same-metric double insert OK + duplicate provenance token refused; enum values
  (`declared` accepted / bogus source rejected / `UNMEASURABLE_NO_METRIC`
  accepted / bogus lever status rejected).

### #17 — C4 multi-lever resolution (commit `0c21a0d`)

- `resolve.py`: `_levers_for` is now the `(decision_id, metric_id)` query on
  `levers` ⋈ `actions`. New pure helpers `shipped_levers()` (status `SHIPPED`,
  ship date ≤ today, deduped by action, sorted so `[0]` is the intervention) and
  `ship_span_days()`. `pre_verdict()` returns UNATTRIBUTED / VOIDED /
  UNRESOLVABLE(span) — `LeverConflictError` is gone (multi-lever is a supported
  path now, not a broken invariant; `run_resolution.py` handler removed).
- `bridge.py`: new `persist_lever_cluster_readout()` — materializes a CLUSTER
  node/edge over exactly the shipped lever actions through the SAME collision-
  overlay writers (`_persist_clusters` now returns cluster ids). Single-
  intervention ITS at the earliest ship; window = `[first ship, last ship + 14d]`;
  idempotent on the cluster's stable `(scope, metric, window_start)` key. No new
  ITS method.
- Verdict flow: UNMEASURABLE_NO_METRIC is checked FIRST (declared source + zero
  observations, before lever logic and before any ITS), then pre-verdicts, then
  1-lever → ACTION edge / n-lever → CLUSTER edge. The scoring denominator for the
  cluster is the pre-window mean at the earliest ship (same convention as the
  bridge's cluster split). Memory tuple: singular `lever_ref` fields on the
  single path (byte-for-byte regression, asserted), `lever_refs`/`cluster_id`/
  `ship_span_days` on the cluster path.
- Tests +7 (test_resolve.py 26 → 33): 4 unit (member derivation/dedup/order,
  span boundary inclusive-at-MAX, all-dropped VOIDED, within-span proceeds) and
  5 e2e minus repurposes (cluster CONFIRMED via CLUSTER edge + persisted window
  asserted; single-lever tuple-shape regression; span UNRESOLVABLE with no edge;
  all-dropped VOIDED; declared-no-obs UNMEASURABLE with zero nodes materialized).

### #15 — C2 onboarding funnel (commits `d50be7c`, `10753fb`)

- **Auth stub as agreed**: `lib/auth/session.ts` is the single seam — returns the
  demo workspace exactly as `/actions` resolves scope; #5 swaps its body for the
  Supabase Auth session and the funnel's server actions don't change.
- Routes: `app/(onboarding)/layout.tsx` (minimal logo shell) +
  `app/(onboarding)/onboarding/page.tsx` (`force-dynamic`) + `server-actions.ts`.
  One client wizard (`components/onboarding/OnboardingFunnel.tsx`):
  Describe → Structure → Commit → Watch.
- **LLM seam** (`lib/onboarding/llm.ts`): mirrors `lib/summary/live-polish.ts`
  (raw fetch, `claude-opus-4-8`, strict JSON schema, server-side only, FAIL-SAFE
  → fallback card on any trouble). The prompt forbids suggesting magnitudes/
  directions — questions must not contain numbers (elicit-not-assert).
  Pure layer (`lib/onboarding/parse.ts`): paste guard, response mapping with
  clamps (title ≤ 120, questions clamped/padded to 2-3, category → known set),
  fallback card (title = first line, metric = manual entry).
- **Declared metric** (`lib/onboarding/commit.ts`, injected-client like
  lib/ingest): case-insensitive name match REUSES a wired metric (strictly
  better — real precedent, real observations); otherwise exactly one
  `source='declared'` row. Commit inserts `decisions` + `predictions`; the
  prediction persists **UNATTRIBUTED as a state, not a written verdict**:
  `resolved_verdict` stays NULL with zero `levers` rows — writing the terminal
  verdict at commit would make C3's arming impossible (resolve.py skips
  terminal rows). At `resolution_date` with no lever it resolves UNATTRIBUTED;
  with a declared unwired metric, UNMEASURABLE_NO_METRIC (C4). This is the one
  place I interpreted the runbook's "predictions row UNATTRIBUTED" — evidence
  below shows the row.
- Precedent panel reuses `getPriorsForReferenceClass` (#9) — honestly "no
  precedent yet" on a fresh metric. Mechanism gate: the Continue button is
  disabled until the mechanism is named (verified live: `disabled=true` → false).
- **QA-caught fix** (`10753fb`): the structured-output endpoint 400s on
  `minItems > 1`; every paste silently fell back. Schema loosened (mapping layer
  already clamps); verified live end-to-end after the fix.

## Gate evidence

| Gate | Result |
|---|---|
| 1. `supabase db reset` | Clean, all 9 migrations incl. `20260712040728_cold_start_levers.sql` |
| 2. Engine pytest | **1121 passed** (was 1110: +4 RLS, +7 resolve; nothing down) |
| 3. `is_lever` grep | Clean — zero live references (`.py/.ts/.tsx/.sql`, excluding the immutable prior migration and the new migration's own `drop column`) |
| 4. Lib tests | **253 passed, 0 failed** (was 245: +6 unit parse, +2 DB-gated integration — integration RAN against the local stack, not skipped) |
| 5. `tsc --noEmit` + `next build` | Both clean; `/onboarding` builds as dynamic (ƒ) |
| 6. Live browse QA | Full round-trip + garbage path, screenshots below; DB verified |
| 7. `/actions` + `/impact` | Both render from the live DB, no console errors; the funnel's committed prediction appears in the decisions list; known impact figures intact (ARR +$261K, Activation +5.6pp) |

Gate-6 DB verification (local Postgres, after the live round-trip):

```
 name                   | source   | obs
 Weekly activation rate | declared |   0        ← exactly one row, no observations

 direction | magnitude | resolution | resolved_verdict | levers | mech
 POSITIVE  |         6 | 2026-09-30 | NULL             |      0 | activation
                                      ^ UNATTRIBUTED state: unresolved + no lever
```

Screenshots (committed): `docs/qa/coldstart-20260712/`
`step2-paste.png` · `step3-card.png` (LLM card + 3 pointed questions) ·
`step4-commit.png` (declared metric + "no precedent yet") ·
`step5-prediction-card.png` (countdown "Resolves in 80 days", Unattributed note) ·
`fallback-garbage-paste.png` (manual path, never a dead-end) ·
`fallback-metric-reuse.png` ("Support Tickets" matched the wired metric) ·
`actions-tab.png` · `impact-tab.png`

Seed: `seed_demo.py` PASS through the levers path — all 6 target verdicts land
live (CONFIRMED 13.5% in-CI, REFUTED, DIRECTION_CONFIRMED, INCONCLUSIVE,
GATHERING, VOIDED via the unshipped `DETECTED` lever).

## Decisions taken (and why)

1. **UNATTRIBUTED is a state, not a commit-time write** — see #15 above. The
   card and the decisions list both label it "no lever"; the DB row stays
   resolvable so C3 can arm it.
2. **`MAX_CLUSTER_SPAN_DAYS = 28`** (env `CAUSENT_MAX_CLUSTER_SPAN_DAYS`): two
   14-day descriptive post-windows — a staged rollout, not two separate bets.
   Boundary is inclusive (== 28 clusters; 29 refuses), unit-tested.
3. **Shipped-lever predicate = `status == 'SHIPPED'` AND ship date ≤ today**,
   deduped by action. Status is authoritative lifecycle (C3 maintains it);
   `effective_date` stays the intervention date. A DROPPED lever whose ticket
   had shipped is still excluded — the drop is the signal.
4. **Metric-name match reuses the wired metric** instead of shadowing it with a
   declared duplicate — unlocks real precedent and real observations; AC's
   "exactly one declared row" holds on the fresh-name path (integration-tested).
5. **Lever cluster reuses the bridge's collision-overlay writers** (returns ids
   now) rather than a parallel implementation — same upsert identity, same
   evidence shape, `clustered=true`, members get `cluster_id` stamped.
6. **`LeverConflictError` deleted** (not deprecated): same-metric multi-lever is
   the supported path per the locked A2 decision; keeping a dead raise would
   misdocument the invariant.
7. **Lever rows written by the Actions-tab mapping** get `status` from the
   action's ship date (`SHIPPED`/`DETECTED`) and `target_source` github unless
   the action came from jira — the C3 draft→create lifecycle starts later than
   these (they map already-existing actions).

## Blockers / deferred (none blocking the PR)

- **#15 stays open**: Step 1 auth (#5) + funnel instrumentation (30s-to-type,
  Step-4 commit rate — epic DoD item 5) + the E2E-under-auth test. The funnel is
  reachable at `/onboarding` directly; nothing redirects into it yet (that's the
  post-OAuth redirect, #5).
- `lib/predictions.ts` `leverChange()` docstring still describes the v1
  one-lever UI invariant — the Actions-tab capture still enforces one lever per
  decision UI-side, which is now merely conservative, not wrong. Multi-lever UI
  arrives with C3/C5.
- Funnel commit is two inserts (decision, then prediction) — same v1 atomicity
  stance as the Actions-tab flow (an orphan decision is inert, not wrong).
- `sourceLabel()` in `lib/data/config.ts` maps any non-connector source to
  "CSV" for display; a declared metric shows as "CSV" in the Data Workshop list.
  Cosmetic; worth a "Declared" label in C5.

## Resume instructions

```bash
cd /Users/adamowens/Code/worktrees/coldstart-c1-c2-c4   # or check out the branch
supabase start && supabase db reset
cd engine && /Users/adamowens/Code/causent/engine/.venv/bin/python persistence/seed_demo.py
.venv/bin/python -m pytest -q         # expect 1121 passed (use the MAIN checkout's venv)
cd .. && npm test                     # expect 253 passed (integration needs the local stack)
npm run dev                           # /onboarding = the funnel; /actions = decisions list
```

- PR is open and **must not be merged** without review; on merge, close #14/#17,
  keep #15 open, and reconcile `docs/STATUS.md` (untouched tonight by design).
- NEXT per epic #13: C3 (#16, create-lever-from-decision + GitHub read-only +
  reconciliation — the funnel's "coming soon" note points at it), then C5 (#18).
  The design-partner mechanism-mapping test still gates T2/T3 per STATUS.
