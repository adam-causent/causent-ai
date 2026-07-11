# Causent — Build Status & Resume Guide

Last updated: 2026-07-10. Single source of truth for "where are we and how do I pick up."
Product: **"Did-It-Ship, Did-It-Work"** — connect GitHub, tie each shipped action to a
business metric, produce an honest causal readout on a scoped causal graph.

## TL;DR

The **full product loop is now closed end-to-end (locally, adversarially verified)** and is
**merged to `main`** (PR #1 `overnight/wire-up` → `main`, landed 2026-07-08). Seeded GitHub-PR
→ metric data flows through the **real** persistence bridge into `causal_edges` + append-only
`evidence_objects`, and the Next.js dashboard renders those engine-derived readouts **directly
from Supabase** (not seed), honoring the 45/45 confident-vs-gathering-data boundary. GitHub
ingestion, the honest AI-summary layer, and a deployable engine function are all built +
tested. The **live summary guardrail is now proven against the real model** (19/19 vs
`claude-opus-4-8`, 2026-07-04). **Everything else that remains is credentialed, not
code-blocked:** a GitHub token/OAuth (live ingestion) and Vercel creds (engine deploy). See
`docs/OVERNIGHT_REPORT_2.md` for the phase-by-phase evidence.

```
✓ Plan     office-hours → CEO → Eng → Design reviews (all CLEARED)
✓ Engine   honest causal inference, 1058 tests (1078 with engine-fn), signed off 8/10
✓ Schema   11 tables, RLS + RBAC memberships, tenant-isolation verified (0 leaks)
✓ Bridge   engine → evidence (append-only) → causal graph, live E2E verified
✓ CI       all gates re-run on every push (GitHub Actions + Supabase)
✓ App/UI   approved shell (Next 16): 3 tabs + Core Metrics drawer, visual-QA'd vs mockups
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
☐ LIVE     GitHub token (ingest)  ← the one remaining credential
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
- **Schema + RLS** — `supabase/migrations/` (4 files, 11 tables): org→project→workspace
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

# Full suite (1058 tests: engine + RLS isolation + bridge E2E):
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

## Next (priority order)

The four items above (UI↔Supabase, ingestion, engine deploy, summary layer) are now **BUILT
and verified locally** on `overnight/wire-up`. What remains:

0. ~~Merge `overnight/wire-up` → `main`~~ — **DONE** (PR #1, 2026-07-08). `main` is the loop.
1. **Live credentials** — two of three now closed:
   - ~~`ANTHROPIC_API_KEY`~~ — in `.env.local`; live guardrail already proven 19/19 (2026-07-04).
   - ~~Vercel creds~~ — **engine DEPLOYED to production 2026-07-11**:
     `https://causent-engine.vercel.app/api/engine`, standalone project `causent-engine`
     (see `api/DEPLOY.md` for why it's split from the app project + the SSO-wall gotcha);
     `CAUSENT_ENGINE_SECRET` set on prod+preview+`.env.local`; smoke-tested 405/401/200
     with the AUTOCORRELATION guard firing correctly on synthetic data. Redeploy via
     `scripts/deploy-engine.sh --prod`. (App itself still undeployed — needs cloud
     Supabase envs; the root project `causent` is linked and `.vercelignore`-scoped.)
   - GitHub token → live ingestion via `lib/ingest/cli.ts` — **the one remaining
     credential** (fine-grained PAT, Contents:Read on the target repo, as `GITHUB_TOKEN`
     in `.env.local`; per SEC3/T-TOK the durable wiring is a per-connection Vault token).
2. **Per-request freshness** — dashboard routes are statically prerendered (DB read at build
   time). Add `export const dynamic = "force-dynamic"` (or revalidation) when live freshness is
   needed. Swap the demo service-role server client for a per-request `@supabase/ssr` RLS client
   (TODO in `lib/supabase-server.ts`) once real auth/session wiring lands.
3. **Auth** — multi-provider (email + Google + GitHub + SSO) via Supabase (SEC2).
4. **Design polish** — run `/plan-design-review` → `/design-review`; also fix the stale "Last 30
   Days vs Prior 30 Days" subtitle on the Impact-by-Metric panel (bars are net confident causal
   ITS lift across all history, not period-over-period). ImpactBar axis ticks, static account menu.
5. **Install the `server-only` npm package** so an errant client import of `lib/supabase-server.ts`
   fails at build time, not just at request time (defense-in-depth; no leak today).

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
- `docs/ENGINEERING.md` — engineering standards (clean/atomic/component-tested/panel bar).
- `engine/OVERNIGHT_REPORT.md` — the engine build + honesty-fix + bridge build history.
- `supabase/SCHEMA_REPORT.md` — schema/RLS report + residual risk.

## Housekeeping

- OpenAI API key **rotated 2026-07-03** (old leaked key revoked; new key in `~/.gstack/openai.json`, 600, outside git).
- Local Supabase (Docker) may still be running; `supabase stop` to shut it down.
