# Overnight Report 8 — Resolution port + Jira parity (2026-07-18)

Two independent features, two PRs off `main`, both built + verified locally and
awaiting review. No migrations. Console/credential steps deferred (as with every
prior go-live).

## PR #24 — Resolution port: run the sweep in production

**Problem.** `/api/cron/resolve` shelled out to `run_resolution.py` via `spawn`,
which **no-ops on Vercel** (no Python venv). The daily resolution sweep silently
did nothing in prod; predictions only resolved when the runner was invoked by
hand. That's the gap between "the demo works when I drive it" and "the loop runs
itself" — and the live app is now the partner-demo surface.

**Approach — a stateful sibling to the engine fn.** The engine function
(`api/engine.py`) is deliberately credential-free; resolution is inherently
stateful (reads predictions/levers/metrics, materializes the lever edge through
the real bridge, writes verdicts). So it can't fold into the engine.

- **`api/resolve.py`** — a thin HTTP wrapper over `resolve_due_predictions`.
  `handle_request(raw_body, secret, *, sweep=…)` is pure; the injected `sweep`
  seam means guards + serialization are tested with **no DB**. The default sweep
  connects **RLS-scoped** (`SET ROLE authenticated` + `request.jwt.claims` sub),
  the exact contract `run_resolution.py` proved. Holds **one** credential (a
  Postgres DSN) → deploys as its OWN project `causent-resolve`
  (`scripts/deploy-resolve.sh`), never in the credential-free engine.
- **`app/api/cron/resolve/route.ts`** — POSTs the deployed fn at
  `CAUSENT_RESOLVE_URL` in prod; local-runner fallback in dev; **degrades loudly**
  when neither is configured (mirrors `reconcile-levers`).

**Verified.** 13 new guard tests + 33 engine-fn tests green; `tsc` clean; and the
**real DB path** against a seeded local stack resolved a due prediction to
`GATHERING` (auto-extended +14d) and one to `VOIDED`, summarizing verdict counts
correctly. Wrong secret → 401 even against a live DB.

**Go-live (deferred).** `scripts/deploy-resolve.sh --prod`; set
`CAUSENT_RESOLVE_SECRET` + `DATABASE_URL` (session-pooler DSN) on `causent-resolve`;
set `CAUSENT_RESOLVE_URL` + the same secret on the app. Full steps in `api/DEPLOY.md`.

## PR #25 — Jira parity + write-scope auto-create (closes #19)

Brings Jira to parity with the GitHub create-from-decision lever path (#16) and
adds the **write-scope "efficient path"** for **both** trackers. **No migration** —
`levers.target_source` already allows `'jira'`; `actions`/`transition_events.source`
both allow `'jira'`.

- **Jira read-only** (`lib/connectors/jira.ts`) — `CreateIssueDetails` deep-link;
  the A3 **two strategies in order** (issue property `causent.decisionId` →
  description/label token scan, reusing the GitHub scan so `provenance_token` is
  uniform); the canonical map (Done+Fixed→`SHIPPED`; Done+Won't-Do **and**
  sprint-removal-while-not-Done→`LEVER_DROPPED`; re-point/re-assign→null).
  `lib/levers/jira-webhook.ts` + `app/api/webhooks/jira/route.ts` — verify + dedup
  (deterministic `provider_event_id`) + detect.
- **Write-scope auto-create** (`lib/connectors/write.ts` + `lib/levers/autocreate.ts`)
  — GitHub + Jira create adapters behind an injected transport; Jira also sets the
  `causent.decisionId` issue property (strategy 1) with the label as backstop.
  draft → create → detect, zero clicks, idempotent at two layers (never a
  duplicate ticket).
- **Wiring** — `draft.ts` is tracker-aware (GitHub byte-identical); server actions
  handle both trackers + the env-gated fast lane; `reconcile` skips non-GitHub
  levers in the live poll; `LeverCreate` gains a GitHub/Jira toggle + the
  emphasized fast lane with graceful fallback.

**Verified.** 27 new tests (18 Jira core, 5 write adapters, 4 Jira/write-scope
integration against local Supabase) + the 4 GitHub integration tests unchanged (no
regression from the `draft.ts` refactor). Full lib suite **334 tests, 0 fail**;
`tsc` clean; prod-equivalent `next build` clean (new `/api/webhooks/jira` route
present).

**Go-live (deferred).** Jira: a Jira automation/webhook → `/api/webhooks/jira` with
`x-causent-jira-secret`, plus `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` for the
write path. GitHub write lane: `GITHUB_WRITE_TOKEN`. Until set, both use the
read-only deep-link + paste (fully working).

## Environment notes

- The local `next build` fails on the dangling `engine/.venv/bin/python` symlink
  when Turbopack traces the resolve route — a **local-only** artifact (prod's
  `.vercelignore` excludes `/engine`). Verified the build clean by moving `.venv`
  aside (mirrors prod), then restored it.
- Docker Desktop + the local Supabase stack had stopped mid-session; restarted both
  for the integration gates (a fresh DB — the integration tests seed their own
  scratch tenants).
