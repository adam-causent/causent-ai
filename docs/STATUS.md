# Causent — Build Status & Resume Guide

Last updated: 2026-07-03. Single source of truth for "where are we and how do I pick up."
Product: **"Did-It-Ship, Did-It-Work"** — connect GitHub, tie each shipped action to a
business metric, produce an honest causal readout on a scoped causal graph.

## TL;DR

The **entire backend "did-it-work" loop is built, adversarially verified, and on `main`**
(pushed to `github.com/adam-causent/causent-ai`). What remains is the app/UI, GitHub
ingestion, deploy, and the AI summary layer — the conventional shell, not the hard part.

```
✓ Plan     office-hours → CEO → Eng → Design reviews (all CLEARED)
✓ Engine   honest causal inference, 1058 tests, data-scientist + causal-researcher signed off 8/10
✓ Schema   11 tables, RLS + RBAC memberships, tenant-isolation verified (0 leaks)
✓ Bridge   engine → evidence (append-only) → causal graph, live E2E verified
✓ CI       all gates re-run on every push (GitHub Actions + Supabase)
☐ App/UI · GitHub ingest · deploy engine · Anthropic summary  ← next
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

## Next (priority order)

1. **App/UI** — Next.js scaffold + Supabase client + the approved shell (global header +
   `Project: Orbit / Gummy Alpha` breadcrumb + 3 tabs: Data Workshop / Actions & Decisions /
   Impact + persistent bottom Core Metrics drawer). Mockups: `~/.gstack/projects/adam-causent-causent-ai/designs/causent-shell-20260702/`. **Needs your visual QA + `/plan-design-review` → `/design-review`.**
2. **GitHub ingestion** — capped backfill (PRs/issues → actions), OAuth/PAT read.
3. **Deploy the engine** as a Vercel Python function behind a shared-secret + input/action cap.
4. **Anthropic summary layer** — templated-from-numbers summary + adversarial/regression eval.
5. **Auth** — multi-provider (email + Google + GitHub + SSO) via Supabase (SEC2).

## Open risks / TODO

- CI's first cloud run not yet confirmed green (local venv is Python 3.14, CI pins 3.12 —
  likely fine; watch the first Actions run).
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
