# Causent — Build Status & Resume Guide

Last updated: 2026-07-22. Single source of truth for "where are we and how do I pick up."
Product: **dual cold-start on one causal graph** — the retrospective wedge ("Did-It-Ship,
Did-It-Work": tie each shipped action to a metric, honest ITS readout) PLUS the prospective
on-ramp (human pre-registered prediction → drift watch → engine-measured resolution). See
`docs/designs/prospective-prediction-loop.md` (approved 2026-07-11).

**Active product plan:** replace form-like onboarding with an AI-assisted Decision Report
that makes Causent's leverage visible immediately. One initial prompt produces multiple
coordinated assets from one typed report aggregate: a partial three-section report,
sourced-evidence summary with up to three proof claims, metric hypothesis/chart, action-plan
summary, up to three draft actions, and an explicit supplied-mock-up state. Focused inline questions fill required gaps; this is not a
general chatbot. One final idempotent operation materializes the decision, human prediction,
metric relationship, and selected actions. Approved design:
`docs/designs/ai-assisted-decision-report.md`.

## TL;DR

**Both existing loops and Decision Report Slices 1–7 are on `main`; Slice 8 and the accepted
same-day partner-feedback follow-ups are prepared on `codex/decision-report-slice-8` for review. Bounded generation, durable report persistence, human-controlled
metric/prediction/action activation, and the atomic Actions & Decisions handoff are
live-validated. Report-native dashboard isolation, Reports-tab indexing, and authenticated
daily CSV ingestion into the activated report metric, and the private sanitized supplied-image
path are implemented. Named workspace CSV metric creation now feeds an in-place, up-to-five
workspace-metric selector without widening report-owned decisions or impact; Data Workshop uses
one consolidated uploader, onboarding exposes the same multi-select beside the report's one
prediction metric, and the selected metrics drive the persistent bottom drawer. The report-native
Actions view now starts with the durable Decision Summary, uses expandable action rows, explains
the real GitHub/Jira handoff, and supports audited manual completion. Decision Report history now
has checked, recoverable removal; action rows and chart flags share stable `D1A1` coordinates, and
the drawer has working date-range and daily/weekly controls. Short-history action evidence now
renders as an explicitly descriptive 14-day cross-check while the causal result remains withheld
until ITS has 45 days on each side. Slice 9 now adds an operator-managed per-user
Decision Report rollout with a pinned legacy rollback path; saved reports survive rollback.
Local clean-state browser acceptance and the remaining sparse/keyboard/adversarial gates pass.
Three real initially unassisted partner sessions remain the release gate.**
The retrospective loop closed 2026-07-08 (PR #1) and the
**prospective Foundations tranche landed 2026-07-12 (PR #12, epic #6, children #7–#11
all closed, cloud CI green)**: intent-layer schema (`decisions`/`decision_actions(is_lever)`/
`predictions`/`prediction_revisions`/`transition_events`), the 8-state resolution verdict
machine + CLI runner (`engine/persistence/resolve.py` + `run_resolution.py`), on-the-fly
reference-class priors (`lib/priors.ts` + `lib/data/priors.ts`), a decisions-first Actions &
Decisions tab (elicit-not-assert capture, lever mapping, reason-gated revisions, caveat-first
readout), and seed exercising all six target verdicts through the REAL engine. Evidence:
`docs/OVERNIGHT_REPORT_3.md`. **The baseline-metric-drift DEMO beat shipped (PR #22, 2026-07-13)** —
reconciled through office-hours + CEO/Eng/Design review as the demo showcase (a change-point detector
over the metric's own series), distinct from the still-gated webhook lever-descope drift (#18).
**The Decision Report is an unvalidated product thesis.** Build only the partner wedge first,
then require observed unassisted use before starting broader URL/PDF ingestion, conversational
delivery, or production automation.

```
✓ Plan     office-hours → CEO → Eng → Design reviews (all CLEARED)
✓ Engine   honest causal inference, 1058 tests (1078 with engine-fn), signed off 8/10
✓ Schema   11 tables, RLS + RBAC memberships, tenant-isolation verified (0 leaks)
✓ Bridge   engine → evidence (append-only) → causal graph, live E2E verified
✓ CI       all gates re-run on every push (GitHub Actions + Supabase)
✓ App/UI   approved shell (Next 16): 4 tabs + Core Metrics drawer, visual-QA'd vs mockups
✓ Loop     seed → real bridge → Supabase → UI; /impact matches DB cell-for-cell (A1–A4, A-verify)
✓ Ingest   fixture-tested capped/idempotent GitHub → actions + live adapters/CLI (C1, C-verify)
✓ Summary  honest deterministic readout→prose + adversarial/regression eval (B1, B2, B-verify)
✓ Engine-fn  deploy-ready Vercel Python fn (guards+caps), stateless, no creds (D1, D-verify)
✓ Live-eval Anthropic summary guardrail proven vs claude-opus-4-8 (19/19, 2026-07-04)
✓ Landed   PR #1 overnight/wire-up → main (2026-07-08); local main synced
✓ UI-v2    Reports tab + North Star objective + Aggregated-Impact restructure (2026-07-09)
✓ UI-v3    FINAL brand logo + nav deep-links + objectives DB parity + mobile fixes +
           ingest hardening (2026-07-10, branch overnight/ui-polish)
✓ ENGINE   LIVE at https://causent-engine.vercel.app/api/engine (2026-07-11, standalone
           Vercel project via scripts/deploy-engine.sh; secret set; smoke-tested 405/401/200)
✓ PIVOT    prospective-prediction-loop design approved + docs on main (2026-07-11)
✓ PROSPECT Foundations tranche MERGED (PR #12, 2026-07-12): intent schema + verdict
           machine + priors + decisions-first Actions tab + seed (1110 pytest, 245 lib)
✓ COLDSTART C1+C4 MERGED (PR #20, 2026-07-13): levers table (multi-lever, drops
           is_lever), declared metric + UNMEASURABLE_NO_METRIC, cluster-resolution path
✓ AUTH     #5 invite-only Google-OAuth allowlist + create-from-decision GitHub connector
           scaffolding MERGED (PR #21, 2026-07-13); prod stays open via CAUSENT_LOCAL_DEMO=1
✓ DRIFT    baseline-metric drift DEMO beat MERGED (PR #22, 2026-07-13): change-point detector
           (segmented_ols reuse) + calm assert-fact notice + stub Restate; seeded, 1147 pytest
✓ FUNNEL   #15 onboarding funnel CLOSED (PR #23, 2026-07-13): Step-1 auth wired + instrumentation
           + E2E-under-auth; #18 ship-state + resolution scorecard shipped (drift-alert deferred)
✓ DEPLOY   app LIVE at https://app.causent.ai (2026-07-16): Vercel project `causent-ai`
           (git-connected, auto-deploys main), invite-only Google OAuth ARMED (allowlist
           hook + owner invited), cloud Supabase seeded via seed_demo.py — all 7 verdicts
           + drift beat live; Google OAuth + GitHub App + fine-grained PAT all configured
✓ RESOLVE  resolution PORT MERGED (PR #24) + DEPLOYED 2026-07-18: api/resolve.py stateful
           sibling of the engine fn LIVE at https://causent-resolve.vercel.app/api/resolve
           (own Vercel project `causent-resolve`); CAUSENT_RESOLVE_SECRET set on both projects
           + CAUSENT_RESOLVE_URL on the app; guards smoke-tested (GET 405, no/bad secret 401).
           ☐ ONE STEP TO ARM: set DATABASE_URL (Supabase SESSION pooler DSN, :5432) on
           causent-resolve, then REDEPLOY BOTH projects (Vercel env added post-deploy needs a
           redeploy). Until then the cron 500s at the DB connect (auth passes).
✓ JIRA     #19 Jira parity + write-scope auto-create MERGED (PR #25, closes #19): read-only
           deep-link + scan-detect + canonical map + webhook + write-scope issue-property/label
           create; 27 tests + 334 lib green, no migration. Code LIVE on main; route INERT until
           armed. ☐ TO ARM: JIRA_BASE_URL/EMAIL/API_TOKEN/WEBHOOK_SECRET + GITHUB_WRITE_TOKEN
           (Issues:R+W) on causent-ai + a Jira webhook → /api/webhooks/jira (deferred: no Jira
           instance tonight). Read-only deep-link + paste works with zero creds now.
☐ PARTNER  zero-code mechanism-mapping test  ← gates T2 connector completion + #18 drift-alert surface
☐ CONNECT  SUPABASE_SERVICE_ROLE_KEY deliberately withheld from Vercel → webhook auto-detect
           + reconcile cron return 500 (paste-URL attribution works; deliberate, reversible)
☐ OPEN     #16 connector live (creds) · #18 drift-alert surface (gated) · ~~#19 Jira parity~~ (PR #25)
◐ ACTIVE   AI-assisted Decision Report partner wedge: Slices 1–9 implementation complete. The 24.4s
           six-action baseline triggered a sparse three-proof/three-action contract; live
           re-benchmark passed in 13.9s. Durable explicit save/reload is now verified;
           explicit metric/prediction/action activation now materializes atomically and
           hands the user to Actions & Decisions. Data Workshop now imports a bounded
           daily CSV into a named workspace metric or, after activation, only that report's
           confirmed metric. The workspace catalog feeds future report metric selection. One
           sanitized PNG/JPEG now
           attaches privately to an editable revision with scoped preview, safe replacement/
           removal, and active-report locking. Controlled rollout and local acceptance pass;
           three initially unassisted partner sessions remain before broader release.
```

## What's built (all on `main`, verified against live evidence)

- **Causal engine** — `engine/causal/` (C1–C9): pure-numpy segmented-OLS Interrupted Time
  Series + a 7/14-day descriptive cross-check. **Honest by design:**
  - `FLOOR_CONFIDENT = 45` days/side — a confident `belief = 1.0` requires both sides ≥ 45
    daily points AND the CI excludes zero AND it survives BH-FDR AND the placebo didn't fire
    AND Durbin-Watson ≥ 1.3. Below the floor → `INSUFFICIENT_HISTORY` (belief withheld,
    "gathering data"). Strong autocorrelation → capped 0.5 (`AUTOCORRELATION`). FDR-demoted →
    0.5 (`FDR_DEMOTED`, auditable). Placebo fired → vetoed.
  - The causal method is **Interrupted Time Series** — deliberately **not** "CausalImpact"
    (Google's Bayesian structural method, which we do not use).
  - Verified by an AR(1) coverage gate: belief-1.0-on-noise ≤ 6%. scipy is a **test-only**
    oracle; shipped code is numpy-only (`t_ppf` matches scipy to ~1e-9).
- **Schema + RLS** — `supabase/migrations/`: org→project→workspace
  scope hierarchy, `memberships` (RBAC: owner/admin/member/viewer, inherits down), metrics +
  observations, actions (with `rationale_richtext`), clusters, nodes, `causal_edges`,
  append-only `evidence_objects`. RLS on every table via `has_scope_access()`. A live
  tenant-isolation gate proves user A can't read user B; 3 privilege-escalation holes were
  caught + fixed (metric_scope leak, admin→owner self-grant on INSERT/UPDATE).
- **Persistence bridge** — `engine/persistence/bridge.py`: server-side, RLS-scoped (engine
  stays stateless, no DB creds). Fetches metric+actions → `batch_readout` → appends evidence
  → materializes edges (direction/belief/reason from the authoritative ITS row) → cluster
  overlay. Live E2E gate + 3 integrity defects fixed and locked as regression guards.
- **CI** — `.github/workflows/ci.yml`: on every push/PR, spins up Supabase and runs the full
  suite (engine + RLS isolation + bridge E2E).

## How to run it

```bash
# DB-backed tests need the local Supabase stack (Docker must be running):
supabase start            # or: supabase db reset  (clean-slate migration apply)

# Full suite (1147 tests: engine + RLS isolation + bridge E2E):
cd engine && .venv/bin/python -m pytest -q

# Engine-only (no DB): the non-test_rls_/test_bridge_ files.
# Local DB URL used by the DB tests: postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

Python env: `engine/.venv` (numpy shipped; scipy + psycopg are test-only dev deps in
`engine/requirements-dev.txt`).

## Key product boundary (don't lose this)

**A metric needs ~45 days of daily history on each side of a ship date before Causent makes
a confident causal claim.** Shorter → honest "descriptive + gathering data." This shapes the
first-partner ask (point it at a metric with ~3 months of daily history and a change that
shipped 45+ days ago) and the demo (pick such a metric). It is the "credible inconclusive"
the design was built around.

## Loop closed — as built (2026-07-04, branch `overnight/wire-up`)

The dashboard now renders **from Supabase** (materialized `causal_edges` + authoritative ITS
`evidence_objects`), not seed data. `lib/seed.ts` is retained only as a fallback behind
`CAUSENT_USE_SEED=1` (or on any DB-read error, so the app never white-screens). Verified: a
served `/impact` in DB mode matches an independent direct-SQL computation of the graph
cell-for-cell (Actions 10, Confident 4/50, Net +$249K, Gathering 15, Win 50%, per-action
lifts, all-dash sub-45-day May cohort), the 45/45 boundary is faithfully reflected, and the
service-role key does NOT reach the client bundle. New wiring:
- `engine/persistence/seed_demo.py` — idempotent tenant seed, materializes the graph through
  the **real** bridge over an **RLS-scoped** connection (`SET ROLE authenticated`). 10 actions
  (8 May PRs exercise gathering-data + 2 earlier landmark PRs make the confident path
  reachable, since no May-2025 action can reach 45 post-ship points before END_DATE 2025-05-23).
- `engine/persistence/run_demo.py` — bridge runner over the seeded project.
- `lib/supabase-server.ts` (server-only client, browser-import guard) + `lib/data/*` async
  getters + `lib/data/dashboard.ts` (`loadDashboardData()`, React-`cache` memoized, seed
  fallback). Impact cells show a signed number **only** for a confident directional edge;
  withheld/insufficient readouts collapse to "—" — no engine figure is ever fabricated.
- `lib/ingest/*` — fixture-tested, capped, idempotent GitHub → `actions` ingestion (pure core
  + live adapters + CLI, token-gated) with a `(scope_id, external_ref)` unique-index backstop.
- `lib/summary/*` — deterministic honest readout→prose generator + adversarial/regression eval
  harness (golden baseline) + invariant-clamped LLM polish seam (off by default).
- `api/engine.py` + `vercel.json` + root `requirements.txt` — deploy-ready (NOT deployed)
  Vercel Python function wrapping `batch_readout`, shared-secret + input caps, stateless.

### UI iteration (2026-07-09, from live review)

First dogfooding pass over the running app. All changes are seed-mode-visible and thread
through the same `lib/data` → component shapes (DB parity noted in `TODOS.md` P2):
- **Reports tab** (`app/(dashboard)/reports/`, `components/reports/*`) — a new fourth tab. A
  whole-project stakeholder report that rolls up objective + decisions + key metrics + impact
  analysis into one document (and is the summarization that feeds the decision graph). Saved
  reports list + `depth: "full" | "succinct"` (succinct = top movers only). Reuses the honest
  ITS figures + 45-day caveat so a report never overclaims. "Create Report" moved off the
  global header into this tab's "New Report" button.
- **North Star objective** (`components/actions/ObjectivePanel.tsx`) — a purpose document
  pinned above the Actions & Decisions list so the action log reads as bets against a stated
  goal. New `ProjectObjective` type + `seed.projectObjective`; `DashboardData.objective`
  (seed-only, DB path returns null pending an `objectives` row).
- **Aggregated-Impact restructure** (`components/impact/AggregatedImpact.tsx`) — dropped the
  Neutral/Negative tiles; the strip now leads with Metrics-Tracked + Improvement-Rate, then
  the top-4 metrics by magnitude of confident causal lift (from `impactByMetric`).
- **Honesty labels** — the Impact-by-Metric and Aggregated-Impact subtitles no longer claim a
  fabricated "Last 30 Days vs Prior 30 Days"; they say "net confident causal lift (ITS)".
- **Dev-mode flag** — `CAUSENT_USE_SEED=1` in `.env.local` pins the app to the deterministic
  seed dataset for visual iteration (skips the ~7s ECONNREFUSED hang when local Supabase/Docker
  is down). Comment it out to read from a running local Supabase.
- **Deferred** (`TODOS.md` P2): wire inert chrome buttons + cross-links (e.g. Impact actions
  table → the action in the Actions tab); DB-path parity for objective + reports + the trimmed
  aggregated-impact getter.

### Overnight UI + hardening pass (2026-07-10, branch `overnight/ui-polish`)

All verified locally (248 lib tests + 1079 engine tests green, `next build` clean,
live browser QA in both seed and DB modes):
- **Brand logo (FINAL)** — `public/logo.svg` replaced with the FINAL stacked lockup
  (palette `#4285f4`/`#00aaa7`/`#f1c232`); header lockup rebuilt from the real brand
  pieces (`components/shell/Logo.tsx`: dot-grid mark + outlined wordmark); new SVG
  favicon `app/icon.svg` (colored dot cluster on a white tile).
- **Nav wiring** — Impact actions table deep-links to `/actions?selected=<id>`
  (Suspense-wrapped `useSearchParams` seeding); drawer "Add / Layer Metric" →
  `/data-workshop`; account chip → `AccountMenu` dropdown (honest disabled sign-out).
- **Objectives DB parity** — migration `20260710000000_objectives.sql` (workspace-scoped
  north-star doc, metrics-style RLS, explicit grants), `lib/data/objective.ts`,
  seed_demo.py row, RLS-isolation test coverage; `getAggregatedImpact()` trimmed to the
  one improvement-rate figure the redesigned strip reads.
- **Design pass** — ImpactBar round-number axis ticks anchored at 0 (`formatCurrencyTick`);
  2 HIGH mobile fixes (tab-strip/breadcrumb collision; drawer overlap at 375px). Audit
  report: `~/.gstack/projects/adam-causent-causent-ai/designs/design-audit-20260710/`.
- **Ingest hardening (P3)** — within-run external_ref dedup, loud CLI arg validation
  (`lib/ingest/cli-args.ts`), 500-char per-line rationale cap, `server-only` build-time
  guard on `lib/supabase-server.ts` (CLI now needs `--conditions react-server`; noted
  in cli.ts).
- **Deliberately untouched** — the summary layer's golden baseline (formatter change was
  scoped to chart ticks to keep the live-proven guardrail output byte-identical) and the
  seed Gross-Profit generator (would invalidate documented verification figures).

### Approved shell (2026-07-03, still current)

The approved shell (Next 16 + Tailwind v4) was visual-QA'd against the mockups on all three
tabs. Structure (as-built lives at repo root, NOT `/src`):
- `app/(dashboard)/{impact,data-workshop,actions}/page.tsx` + shared `layout.tsx` (persistent
  header + tab strip + Core Metrics drawer); `app/page.tsx` redirects `/` → `/impact`.
- `components/shell` (GlobalHeader, TabStrip, CoreMetricsDrawer, Logo), `components/charts`
  (pure SVG: LineTimeSeries with PR flags, ImpactBar diverging, Sparkline — zero chart deps),
  `components/{impact,data-workshop,actions}`, `components/ui` (Delta = colorblind-safe
  glyph+color+label, Panel, icons).
- `lib/{types,seed,format,derive}.ts`. Brand tokens + single light theme in `app/globals.css`.
- Real brand logo saved at `public/logo.svg` (stacked lockup); header uses a purpose-built
  horizontal lockup (`components/shell/Logo.tsx`).
- Note: `unstable_instant` (Next 16 route hint) was NOT used — it needs `cacheComponents`
  enabled and throws in Client Components. Revisit if enabling Cache Components.

## Prospective layer — as built (2026-07-12, PR #12)

- **Schema** — migration `20260711000000_prospective_layer.sql`: `decisions`,
  `decision_actions(is_lever)`, `predictions` (incl. `resolution_tuple` jsonb = the memory
  tuple priors read), `prediction_revisions` (append-only), `transition_events` (created
  now, WRITTEN only in Tranche 3). RLS via `has_scope_access()` + scope resolvers mirroring
  `metric_scope()`; explicit grants; `actions.source` gained `'jira'`. Isolation gate covers
  all 5 tables.
- **Verdict machine** — `engine/persistence/resolve.py`: maps the lever edge's ITS
  belief-table state to CONFIRMED / DIRECTION_CONFIRMED / REFUTED / INCONCLUSIVE /
  GATHERING (auto-extends `resolution_date` +14d, non-terminal) / UNRESOLVABLE / VOIDED /
  UNATTRIBUTED. Scoring is sign-primary + magnitude-in-CI bonus in NATIVE units:
  `predicted_native = magnitude_pct_mean/100 × the exact ITS pre-window mean` (one
  denominator, no commit-vs-resolution drift; the commit-time native snapshot is
  display-only). Duplicate levers raise `LeverConflictError` before any write. Manual/dev
  runner: `run_resolution.py` (`--today` for the in-the-past demo); cron is Tranche 3.
- **Priors** — pure `lib/priors.ts` (`computePriors`: REFUTED+INCONCLUSIVE included,
  belief-weighted, honest nulls, `hasPrecedent:false` on an empty class) + RLS wrapper
  `lib/data/priors.ts` over terminally-resolved `resolution_tuple`s.
- **UI** — Actions & Decisions tab is decisions-first (`DecisionList`/`DecisionDetail`/
  `PredictionCapture`/`ActionDetail`/`VerdictBadge`; `DecisionEditor` retired; rationale
  lives on the decision). Elicit-not-assert is structural: the magnitude input is never
  pre-filled; the precedent panel only describes. Lever proposal = deterministic
  primary-metric heuristic behind a documented seam (LLM version later, off-by-default like
  lib/summary). Revisions require a logged reason. `/actions` is `force-dynamic` (it
  writes); `?selected=<actionId>` deep-links resolve to the parent decision.
  `Action.shippedAt` is now nullable (unshipped VOIDED lever #8440).
- **Seed** — `seed_demo.py` seeds 6 decisions + predictions and resolves them AS THE USER
  through the real machine: all 6 target verdicts verified live (CONFIRMED lands in-CI at
  13.5% of ARR mean). New actions: churn probe #8290 (INCONCLUSIVE), unshipped #8440
  (VOIDED) → 12 actions total. `lib/seed.ts` mirrors the story (incl. landmarks #8107/#8256,
  which the TS seed previously lacked).

## Cold-Start tranche — as built (2026-07-13, PRs #20 + #21)

- **PR #20 (closes #14, #17)** — `levers` table (multi-lever incl. same-metric via cluster
  overlay; `decision_actions.is_lever` dropped), declared metric on the prediction,
  `UNMEASURABLE_NO_METRIC` verdict, `resolve.py` multi-lever cluster-resolution path +
  ship-span guard, onboarding funnel + `LeverCreate` UI (progresses #15). Migration
  `20260712040728_cold_start_levers.sql`.
- **PR #21 (closes #5, progresses #16)** — invite-only Google-OAuth allowlist
  (`proxy.ts` guard + `lib/auth/*` + `scripts/invite.ts` + migration
  `20260712052812_auth_allowlist.sql`; Next 16 middleware→proxy rename) and the
  create-from-decision GitHub read-only connector spine (`lib/connectors/github*.ts`,
  webhook + reconcile-levers cron routes, deep-link+paste flow). Connector is INERT until
  the live GitHub App + PAT land. Gates green at merge: 1128 pytest, 262 lib tests.
  Evidence: `docs/OVERNIGHT_REPORT_5.md`, QA shots `docs/qa/auth-connector-20260712/`.

## Baseline-drift beat — as built (2026-07-13, PR #22)

- **PR #22 (merged, `26efd3c`)** — the demo showcase from this session's office-hours + CEO/Eng/Design
  reviews. A **change-point detector** (`lib/drift.ts` + `lib/data/drift.ts`) that reuses the engine's
  `segmented_ols`/`step_ci` level-shift fit, scanning the **pre-intervention window only** (so a working
  lever is never mistaken for drift), with a guard (min points + magnitude floor + declared/no-obs →
  "no baseline yet"). A **calm assert-fact `DriftNotice`** on the prediction card — info surface not an
  alarm, NEUTRAL/slate delta (a fact, not a verdict) — and a **stub Restate** over the existing
  `prediction_revisions` table. Seeded on a dedicated **New-User Activation** metric (avoids corrupting a
  core metric's action→metric graph). Gates: 1147 pytest, 269 lib, CI green; Restate DB-verified;
  4 states screenshotted (`docs/screenshots/drift/`). Evidence: `docs/OVERNIGHT_REPORT_6.md`.
- **Not yet live:** the detector runs on SEEDED data (compute-on-read). Live detection needs a real
  connected metric, and the level-shift threshold tuning is a documented open question. The notice +
  Restate are demoable now. Design doc: `~/.gstack/projects/adam-causent-causent-ai/adamowens-main-design-20260712-220650.md`.

## Funnel finish + ship-state/scorecard — as built (2026-07-13, PR #23)

- **PR #23 (closes #15, progresses #18)** — **#15 closed:** Step-1 auth wired into the funnel
  (real Supabase session from #5, `CAUSENT_LOCAL_DEMO=1` dev-session fallback kept), funnel
  instrumentation (`funnel_events` table + `SCORECARD_VIEW` resolution-return signal;
  migration `20260713144706_funnel_events.sql`), and an E2E-under-auth walk. **#18 ungated
  slice:** `components/onboarding/ShipState.tsx` (Step-7 confirmation) + `components/reports/Scorecard.tsx`
  + `lib/scorecard.ts` (predicted-vs-measured, all 7 verdicts incl. `UNMEASURABLE_NO_METRIC`
  connect/self-report prompt + `GATHERING` auto-extend), a `/api/cron/resolve` trigger +
  `vercel.json` cron, and a calm mid-window "still on track" touch. Integrated into
  `DecisionDetail` alongside `DriftNotice` + `MechanismChain`. Gates: engine 1147 (no
  regression), lib 288, tsc/build clean, 9 browse-QA shots (`docs/overnight-7-qa/`).
  Evidence: `docs/OVERNIGHT_REPORT_7.md`.
- **Deferred (gated):** `#18`'s **drift-alert surface** (the `LEVER_DROPPED` assert-fact alert)
  stays behind the mechanism-mapping test + #16 live detection — verified NOT built this run.

## Production deployment — as built (2026-07-16)

- **THE app project is Vercel `causent-ai`** (git-connected to this repo, auto-deploys `main`),
  live at **https://app.causent.ai** (Cloudflare CNAME `app` → Vercel; apex `causent.ai` is the
  separate Astro marketing site). A second Vercel project `causent` (created 7/10 via CLI link)
  is redundant — the repo is re-linked to `causent-ai`; check `.vercel/project.json` before
  `vercel env` commands.
- **Prod env (causent-ai)**: `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` (current publishable),
  `ANTHROPIC_API_KEY`, `CAUSENT_ENGINE_SECRET`, `CAUSENT_DEMO_TODAY=2025-05-23`,
  `GITHUB_TOKEN` + `GITHUB_WEBHOOK_SECRET` + `CRON_SECRET`. **`SUPABASE_SERVICE_ROLE_KEY`
  deliberately withheld** — its only consumers are the webhook receiver + reconcile cron (both
  fail-closed-guarded); until it's added, auto-detection is off and the paste-URL fallback is
  the detection path. `CAUSENT_LOCAL_DEMO` must stay UNSET in prod (its absence arms the wall;
  NB the open-demo escape hatch requires the service key).
- **Cloud Supabase `royftsqyawtyfjolfabd`**: all migrations applied; seeded 2026-07-16 through
  the real bridge (`DATABASE_URL=<session-pooler aws-1-us-east-1, user postgres.<ref>>
  seed_demo.py`, password via `PGPASSWORD` — never in the URL). Seed is teardown-then-reseed
  under the demo-org UUID: safe to re-run, can't touch real users. Invite-only auth live:
  Google provider + Before-User-Created hook (`enforce_allowlist`) + `scripts/invite.ts`
  (service key inline-only). Data API rejects key-only anonymous requests (401) while
  session-authenticated RLS reads work — stricter than default, keep it.
- **Known prod limits**: ~~the resolve cron spawns local Python~~ — **PORTED + DEPLOYED
  (PR #24 merged, `causent-resolve` live)**: the cron HTTP-calls the serverless fn; one env
  step left to fully arm (`DATABASE_URL` on causent-resolve + redeploy both — see run-8 below).
  The drift detector still spawns local Python (same pattern, not yet ported). `/login` is
  publicly reachable and currently
  indexable (no robots.txt — the proxy redirects it; CT logs make the hostname discoverable);
  add `app/robots.ts` + proxy exclusion if stealth matters.

## Next (priority order)

### 1. Finish partner inputs and acceptance around the activation handoff

- Slice 3 now deterministically completes required gaps without another model request. Its live
  Gummy Alpha browser review caught and fixed misleading readiness copy: Decision, Problem, one
  proof claim, the metric mechanism, the Action Plan summary, and one action produce **Ready for
  review**; owners, customers, stakeholders, governance, and mock-ups remain visibly optional.
- The remaining Slice 3 browser acceptance pass covers the sparse safe fallback and keyboard
  focus. Unit coverage already verifies gap ordering, optional-field behavior, command rejection,
  the three-action ceiling, ID preservation, edit/question parity, and fallback completion.
- Slice 4 now adds only `decision_reports` and append-only `decision_report_revisions`, protected
  by scope-bound RLS and checked RPCs. Explicit saves use a database-owned content hash for retry
  idempotency, return an immediate HTTP 409 for stale bases, and reload the exact reviewed
  `DecisionReportV1` plus metric projection from `?report=<id>`.
- Slice 5 turns that packet into three explicit user controls: select an existing workspace
  metric, enter a human prediction, and choose one to three report actions. The AI chart never
  pre-fills the commitment or becomes metric observations.
- One checked transaction validates the exact reviewed revision and atomically creates a decision,
  prediction, planned manual actions, decision-action links, and append-only activation audit.
  Exact retries reuse the same IDs; changed retries return HTTP 409; invalid inputs create zero
  partial rows. No lever, tracker ticket, causal edge, evidence object, or impact claim is created.
- Active reports are immutable and deep-link to the new decision in Actions & Decisions.
  Report-created actions use UUID identities plus a `Planned` label instead of fake PR numbers.
- Partner-feedback polish removes the empty report navigation column. The durable Decision Report
  now supplies the Decision Summary and evidence box; report actions render as expandable rows with
  tracker reference, completion state, details, owner, governance, and a member-only manual
  completion date/explanation path. Connector copy states the current boundary honestly: there is
  no account OAuth yet; configured workspace credentials, read-only create links, pasted URLs, and
  webhooks are the supported paths.
- Core metric selection is separate from report activation. Members can add up to five daily
  workspace metrics in place from Data Workshop or onboarding; selected metrics appear across the
  tabs and drawer, while the active report keeps its one confirmed prediction metric and continues
  to isolate report-owned actions and impact. Trash removes a selected metric; a report-required
  metric remains labeled and locked unless independently selected.
- Decision Reports can be removed from visible history through one confirmed, member-only soft
  delete. Revisions, supplied bytes, and an activated report's canonical graph remain audit-safe,
  but RLS hides removed report/revision/asset surfaces and legacy fallback excludes orphaned
  report-native graph rows. The next remaining live activated report becomes the boundary.
- Report action coordinates are stable and human-readable (`D1A1`, `D1A2`, ...), following the
  reviewed report order. The same coordinate appears in the expandable action header and on the
  Core Metrics event flag; the flag deep-links to that opened action. Drawer controls now apply
  30/60/90/all-data ranges and Daily/Weekly aggregation instead of rendering inert labels.
- Impact now loads the stored descriptive cross-check as well as authoritative ITS evidence. When
  ITS is below the 45-day-per-side confidence floor, the UI may show the 14-day mean shift as
  **preliminary descriptive** while belief remains unknown and the aggregate causal summary stays
  empty. The local Gummy Alpha path renders `+3.1pp` from 46 pre/15 post observations and labels
  the overlapping-action limitation; this is not an isolated causal estimate.
- Automated Slice 5 acceptance includes 376 library tests (337 passed, 39 environment-gated
  skips, zero failures), 4/4 separate live persistence/activation integration cases, and 22/22
  authenticated RLS isolation cases; the full engine suite passes 1,166/1,166. TypeScript,
  focused lint, schema lint, and the documented webpack production build pass. The default
  Turbopack build remains blocked by the existing `engine/.venv/bin/python` symlink escaping
  its filesystem root.
- The Slice 8 release gate passes 420 library tests (373 passed, 47 environment/live-model skips),
  12/12 focused live Supabase persistence/activation/Storage/metric cases, and 40/40 combined
  primary/adversarial RLS cases. TypeScript, focused lint, schema lint, `git diff --check`, and
  the Next.js 16 webpack production build are green.
- Slice 9 adds `decision_report_rollouts`, an operator-managed per-user assignment in the shared
  workspace. New starts resolve to a canonical `?flow=decision-report|legacy` URL. A pinned legacy
  session never migrates when the assignment is enabled; disabling it sends new/unsaved starts to
  legacy; `?report=<id>` always opens an already-created durable report.
- Local clean-state browser acceptance passed live generation, deterministic fallback, direct edits,
  focused keyboard questions, save/reload, browser Back, private-image failure/success, named CSV
  metric creation and selection, activation, manual completion, honest no-evidence Impact, and both
  rollout directions. Existing retry and preliminary-descriptive regression gates remain green.
- Nine report-specific fabricated-evidence cases now cover decision, background, problem, proof,
  mechanism, action summary, owner, customer, and stakeholder claims; none can become sourced.
- Next, run three real initially unassisted partner sessions and record the five-part rubric. Local
  automation is acceptance evidence but does not satisfy the partner-demand gate.
  Schema/provenance/gap tests, durable save/reload, metric selection, action completion, report
  removal, chart controls, and preliminary descriptive impact are already complete and must not be
  reopened as Slice 9 tasks. Warehouse connectors and automatic causal recomputation remain
  separate follow-up work.

### 2. Finish the partner wedge

- Partial three-section report plus coordinated evidence, metric, action, and mock-up views.
- Inline focused gap questions rather than general chatbot infrastructure.
- Existing metric confirmation, named workspace CSV metric creation, and human prediction commitment
  are implemented; active reports remain bound to one confirmed metric.
- The final materialization step is implemented; lever/tracker selection stays separate.
- Feature-flagged rollout with legacy onboarding as rollback is implemented. Real partner validation remains.

Slices 1–9 plus the accepted partner-feedback follow-ups delivered the interactive report, bounded
generation seam, deterministic completion layer, durable revisions, private supplied image,
atomic activation, report-native isolation, named metric ingestion/selection, action completion,
recoverable report removal, chart controls, and honest preliminary impact. Remaining target:
recorded unassisted partner evidence.

### 3. Validate before production expansion

Run at least three initially unassisted partner sessions. At least two must pass four of
five checks: decision accurate, problem accurate, evidence traceable, metric mechanism
plausible, next action usable. Only then begin URL/PDF ingestion, conversational delivery,
richer revision workflows, model routing, or numeric Completion Outlook.

The prepared richer-revision boundary is Slice 10: an activated report may create one explicit
linear successor iteration. The parent remains immutable and operational while the child is a
draft; activating the child atomically advances an explicit series pointer without rewriting prior
decisions, predictions, actions, evidence, or audit rows. This is a documented follow-up, not
implemented code, and remains gated on the partner evidence above unless product direction changes.

### 4. Existing operational work

- Arm `causent-resolve` with its session-pooler `DATABASE_URL`, then redeploy both projects.
- Run the separate zero-code mechanism-mapping test before building the gated webhook
  lever-drift alert.
- Connector automation and Jira/GitHub write credentials remain deliberate operator choices;
  read-only/deep-link paths continue to work.

## Open risks / TODO

- ~~CI's first cloud run not yet confirmed green~~ — **RESOLVED 2026-07-09 (PR #3).** The first
  cloud run was red, but not for the Python-version reason guessed here. Two causes, both fixed:
  (a) the schema relied on Supabase's *implicit* default privileges — `setup-cli@latest` in CI
  doesn't grant them to user-migration tables, so every RLS/bridge test hit `permission denied`;
  fixed by an explicit-GRANT migration (`20260709000000_grant_base_privileges.sql`). (b) two
  engine adversarial tests flipped on ~1e-14 float dust from zero-residual fits (nondeterministic
  across BLAS/numpy builds); fixed with a scale-relative dead-zone in the direction/placebo
  classifiers. CI now green (engine + RLS + bridge, 3m28s).
- `owner` role enforced server-side (no DB policy depends on it); hierarchy creation is
  service_role-only — see `supabase/SCHEMA_REPORT.md` residual risk.
- `nodes.semantic_ref` is polymorphic (no FK) — app-enforced integrity.
- The BEFORE_AFTER descriptive stat and the batch action-count cap exist; wire connectors
  (Postgres/BigQuery) later per the PRD (CSV-first).

## Document map

- `docs/designs/did-it-ship-did-it-work.md` — the PRD / v1 build plan (+ review report).
- `docs/designs/decision-graph.md` — the causal-graph data model + belief rules + roadmap (core asset).
- `docs/designs/security-and-auth.md` — auth, RBAC, RLS, threat model, secrets.
- `docs/designs/ai-assisted-decision-report.md` — approved active onboarding/product plan.
- `engine/OVERNIGHT_REPORT.md` — the engine build + honesty-fix + bridge build history.
- `supabase/SCHEMA_REPORT.md` — schema/RLS report + residual risk.

## Housekeeping

- OpenAI API key **rotated 2026-07-03** (old leaked key revoked; new key in `~/.gstack/openai.json`, 600, outside git).
- Local Supabase (Docker) may still be running; `supabase stop` to shut it down.
