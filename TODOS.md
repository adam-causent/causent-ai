# TODOS

Deferred work with enough context to pick up cold. Priority: P1 (blocks ship) →
P3 (nice to have). Effort shown as human → with Claude Code.

## From the 2026-07-04 overnight loop-close (branch `overnight/wire-up`)

Full evidence per item in `docs/OVERNIGHT_REPORT_2.md`. None are code-blocked.

### P1 — Land `overnight/wire-up` → `main`
- **What:** Review the branch diff (loop wiring + ingestion + summary + engine fn) and merge
  to `main`, then push. Nothing on the branch is pushed yet; `main` is untouched.
- **Effort:** S (human) → S (CC via `/ship`). **Priority:** P1.

### P1 — Live credential wiring (3 seams, all built + gated)
- **Anthropic key** → the honest-summary live guardrail proof:
  `ANTHROPIC_API_KEY=sk-ant-... RUN_LIVE_POLISH=1 node --test lib/summary/__tests__/live-polish.test.ts`.
  Also swap `live-polish.ts`'s raw `fetch` for `@anthropic-ai/sdk` behind the same
  `SummaryPolisher` interface for production.
- **GitHub token/OAuth** → live ingestion. Per `security-and-auth.md` SEC3/T-TOK: replace the
  `GITHUB_TOKEN` stand-in in `lib/ingest/github-transport.ts` with a per-connection token
  encrypted in Vault, decoupled from login, 401/403 → reconnect on non-rate-limit auth failure.
  Run under a trusted job identity via `lib/ingest/cli.ts` (needs `tsx`/Next runtime for `@/*`).
- **Vercel creds** → deploy `api/engine.py` per `api/DEPLOY.md`; set `CAUSENT_ENGINE_SECRET`
  (`openssl rand -hex 32`) on preview+prod AND make the same value available to the Next.js
  caller for the `x-causent-engine-secret` header (fn fails closed 401 until set).
- **Effort:** M (human, mostly ops) → S (CC). **Priority:** P1.

### P2 — Per-request freshness + RLS-scoped server client
- **What:** Dashboard routes are statically prerendered (DB read at build time). Add
  `export const dynamic = "force-dynamic"` (or revalidation) where live freshness is needed.
  Swap the demo service-role client (`lib/supabase-server.ts`) for a per-request
  `@supabase/ssr` RLS client (TODO documented in-file) once real auth/session wiring lands.
- **Effort:** M (human) → M (CC). **Priority:** P2. **Depends on:** SEC2 auth.

### ~~P2 — Fix stale honesty-label subtitle~~ ✅ DONE 2026-07-09
- Impact-by-Metric subtitle now reads "Net confident causal lift (ITS, all history)"; the
  Aggregated-Impact subtitle was corrected the same way. Both `page.tsx:20` and
  `AggregatedImpact.tsx` no longer claim a fabricated period-over-period comparison.

### P2 — Wire up in-app navigation (buttons + cross-links)
- **What:** Most chrome buttons are inert placeholders. Tie them to destinations. Highest-value
  link first: the **Actions table on `/impact`** should deep-link each row to that action in
  **`/actions`** (select it in the list + editor). Also: header "Create Report" / "New Project" /
  "Settings" / account menu, and the drawer/tab affordances.
- **Where:** `components/impact/ActionsTable.tsx` → `next/link` to `/actions?selected=<id>`;
  have `ActionsPageClient` read `?selected` (via `useSearchParams`) to seed `selectedId`.
- **Effort:** S–M (human) → S (CC). **Priority:** P2.

### P2 — DB-path parity for the 2026-07-09 UI changes
- **Objective document:** `DashboardData.objective` is seed-only; the DB path returns `null`
  (no schema row yet). Add a project-level `objectives` row + `lib/data` getter so the North
  Star renders from Supabase, not just seed. (`lib/data/dashboard.ts` has the TODO.)
- **Aggregated-Impact strip:** the new strip (metric count + improvement rate + top-4 metric
  impacts) is driven by `impactByMetric` + `metrics` + the improvement-rate stat, so the DB
  path already feeds it — but `getAggregatedImpact()` still computes the old 6-tile set; trim
  it to just the improvement-rate figure it now needs (`lib/data/impact.ts`).
- **Effort:** S (human) → S (CC). **Priority:** P2. **Depends on:** SEC2 auth / live DB.

### P3 — Ingestion + summary hardening (fail-safe today)
- **Ingest (LOW, from C-verify):** dedup capped rows by `external_ref` before insert (a
  within-run duplicate can currently poison a single insert batch, though never duplicates);
  CLI missing-flag value yields NaN window / undefined scope and silently ingests nothing;
  `buildRationale` caps paragraph count but not per-line length (multi-MB line → multi-MB jsonb).
- **Defense-in-depth:** install the `server-only` npm package so an errant client import of
  `lib/supabase-server.ts` fails at build time, not request time (no leak today, runtime guard
  holds). Optionally add the two unreachable summary clamps (CONFOUNDED+belief-1.0, non-finite
  nPre) to `resolveStrength` if the engine↔summary contract is ever loosened.
- **Demo polish:** tune the `seed_demo.py` Gross Profit generator — its organic noise produces
  2 incidental confident-NEGATIVE readouts at the landmark dates (honest engine output, but off
  the intended narrative). Optionally filter Phase-B UI edges to an action's `expected_metric`
  (the bridge scores every action × every in-range metric by design).
- **Effort:** S–M (human) → S (CC). **Priority:** P3.

## P3 — Full-history GitHub backfill worker
- **What:** Background worker to backfill a repo's entire PR/issue history beyond
  the v1 capped window (default ~90 days / N PRs).
- **Why:** v1 caps backfill to fit inside one Vercel request. A design partner who
  wants their full multi-year history rendered on the causal graph will hit that
  ceiling. The capped window is a documented v1 limitation, not a permanent one.
- **Current state:** v1 backfills only the recent window inline on connect (decision
  A2, CEO review 2026-07-02). No worker infra exists.
- **Where to start:** Supabase scheduled function / cron or a queue worker that pages
  GitHub REST/GraphQL with rate-limit backoff (respect `Retry-After`), writes a
  resumable cursor, and upserts ACTION nodes idempotently (dedup on external_ref).
- **Effort:** L (human) → M (CC). **Priority:** P3.
- **Depends on:** a background-job mechanism the PRD deliberately deferred; land the
  v1 capped-window path and a real partner request first.
- **Source:** /plan-ceo-review 2026-07-02, finding A2 + CEO plan
  `~/.gstack/projects/adam-causent-causent-ai/ceo-plans/2026-07-02-did-it-ship-did-it-work.md`
