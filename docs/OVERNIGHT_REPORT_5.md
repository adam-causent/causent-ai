# Overnight Report 5 — #5 invite-only auth + #16 create-from-decision connector

Date: 2026-07-12 (overnight). Branch: `spec/coldstart-auth-connector`, off
`spec/coldstart-c1-c2-c4` (last night's #20). Stacked PR, base
`spec/coldstart-c1-c2-c4`. **Closes #5. Progresses #16.** Part of epic #13.
**Not merged** (by instruction).

## TL;DR

Both jobs built, committed, pushed per-issue; all 8 gates green.

- **#5 — invite-only Google-OAuth allowlist** (commit `b695f57`). The
  design-partner demo launch gate: `allowed_emails` + a Before-User-Created hook
  that rejects non-invited signups + an AFTER-INSERT trigger that provisions the
  membership; `@supabase/ssr` login/callback/proxy; the RLS-client swap done
  without blanking the local demo. **DONE — closes with the PR.**
- **#16 — create-from-decision + GitHub read-only connector** (commit `764cfcd`).
  Steps 5-6: the connector ask + draft-the-lever-ticket-from-the-decision, the
  read-only deep-link + paste-URL fallback as the demoable spine, a
  synthetic-payload webhook receiver, and a mocked-poll reconciliation cron.
  **PROGRESSED — live GitHub App + webhooks + PAT are the credential-gated
  follow-up.**

## What shipped, per issue

### #5 — invite-only auth (commit `b695f57`)

**Migration `*_auth_allowlist.sql`** (created via `supabase migration new`, no
hand-picked timestamp):
- `allowed_emails(email pk, org_id, role, invited_by, invited_at)` — one row
  carries BOTH facts Google OAuth conflates (may-log-in + attach-to-org-as-role),
  since with Google, sign-in *is* sign-up. RLS default-deny; service-role only.
- `enforce_allowlist(event jsonb)` — the **Before User Created** hook. **Contract
  fix:** the issue's draft read `event->'claims'->>'email'`; the current Supabase
  docs put the email at `event->'user'->>'email'` — verified and corrected.
  Returns `'{}'` to allow, an `{error:{http_code:403,message}}` object to reject
  (GoTrue then aborts the insert → no orphan `auth.users` row, and the client
  gets the friendly message → `/login?error=not_allowed`). `security definer`,
  empty `search_path`; `grant execute … to supabase_auth_admin`, revoked from
  everyone else.
- `handle_new_user()` — AFTER INSERT trigger on `auth.users`. Provisions ONE
  org-level `viewer` membership on `ORG ca5e…d1`, idempotent against the
  memberships unique index. Email-less inserts (the seed's synthetic owner has no
  `email`) and non-allowlisted inserts fall through untouched — the seed and RLS
  gate are unaffected.
- Registered in `supabase/config.toml`
  (`[auth.hook.before_user_created]` → `pg-functions://postgres/public/enforce_allowlist`).
  Google provider block added, `enabled = false` locally (empty creds would fail
  `supabase start`), env-driven for prod.

**`@supabase/ssr` plumbing** (Next 16 — read the docs, not training data):
- `lib/supabase-browser.ts` — `createBrowserClient` (anon key only).
- `app/login/page.tsx` — "Continue with Google" (`signInWithOAuth`), plus the
  `?error=not_allowed` note.
- `app/auth/callback/route.ts` — `exchangeCodeForSession` → `/impact`; any
  error → `/login?error=not_allowed`.
- **`proxy.ts`** — **Next 16 renamed Middleware → Proxy** (heeded the deprecation;
  used the current `proxy.ts` convention + exported `proxy`). Refreshes the
  session (getUser) and redirects unauthenticated dashboard requests to `/login`,
  EXCLUDING `/login`, `/auth/*`, `/api/webhooks/*`, `/api/cron/*`, and static
  assets (the webhook + cron routes are unauthenticated by design).

**The RLS-client swap (the #1 regression risk), done safely:**
- `getServerSupabase()` is now **async** and, in production, a per-request
  session-scoped `createServerClient` (runs as `authenticated`; RLS gates every
  row by membership). `getServiceRoleSupabase()` is the explicit RLS-bypass
  client for the seed/provisioner, invite CLI, GitHub ingestion, and the
  unauthenticated webhook/cron jobs ONLY. ~11 call sites `await`ed; the
  `lib/data/*` query bodies are unchanged.
- **DEMO-NOT-BROKEN:** `CAUSENT_LOCAL_DEMO=1` (never set in prod) makes
  `getServerSupabase()` resolve the service-role client so the seeded demo renders
  with no login, and the proxy skips the redirect. This is the runbook's
  documented escape hatch — chosen because there is no real Google session
  locally. The `session.ts` seam resolves the real user (`committed_by`) in prod.
- Invite tooling: `lib/auth/invite.ts` (injected-client, unit-shaped) +
  `scripts/invite.ts` (service-role CLI; reminds you to also add the email as a
  Google test user).

### #16 — create-from-decision + GitHub read-only (commit `764cfcd`)

**Pure core `lib/connectors/github.ts`** (mirrors `lib/ingest` core+adapter, zero
creds): provenance token mint/match (label strategy 1 + body-marker strategy 2,
per locked A3), the prefilled `issues/new` deep-link builder, the
canonical-transition map (opened/reopened → `LEVER_ACTIVE`, closed+completed →
`LEVER_SHIPPED`, closed+not_planned → `LEVER_DROPPED`), HMAC-SHA256 webhook
signature verification, and the issue-event parser.

**Lever lifecycle `lib/levers/*`** (injected client):
- `draftLeverFromDecision` — DRAFTED lever + early `actions` row
  (`source='github_issue'`, `external_ref` NULL) + `decision_actions` link;
  idempotent on the provenance token.
- `detectLever` — the ONE detector both the webhook and the paste-URL fallback
  call: sets `external_ref`, flips `DETECTED`, stamps `detected_at`; idempotent
  (a redelivery / re-paste is a no-op).
- `markLeverCreated` (DRAFTED→CREATED), `timeoutStaleLevers` (→ TIMED_OUT),
  `parseIssueUrl` (paste fallback).
- `processIssueWebhook` — verify → dedup on `(source, provider_event_id)` FIRST
  (the unique index is the idempotency authority) → detect on `LEVER_ACTIVE`.
- `reconcileLevers` — poll seam (mocked in tests) → detect missed levers, then
  time out stale drafts. `now`/`timeoutDays` injected.
- `lib/levers/llm.ts` — ticket-copy drafter (mirrors `lib/onboarding/llm`,
  fail-safe to a deterministic template from the decision).

**Routes** (unauthenticated, excluded from the proxy guard, service-role):
- `app/api/webhooks/github/route.ts` — HMAC-verified; refuses if
  `GITHUB_WEBHOOK_SECRET` is unset (never accepts unverifiable payloads).
- `app/api/cron/reconcile-levers/route.ts` — `CRON_SECRET`-guarded (Vercel Cron
  `Authorization: Bearer`); live poll only when `GITHUB_TOKEN` is set, else the
  timeout sweep still runs. `vercel.json` cron: hourly.

**UI:** `components/onboarding/LeverCreate.tsx` — Step 5 connector ask (framed as
consequence: skip keeps the prediction, loses drift) → Step 6 draft →
"Create in GitHub" deep-link + "I created it — paste the URL" fallback →
attributed state. Wired into the funnel's `done` step (replaces the old
"coming soon" note). Server actions `draftLeverForDecision` + `attributeLeverByUrl`.

Attribution boundary (matches resolve.py / the UI): a DRAFTED/CREATED lever does
NOT attribute; a DETECTED lever (with `external_ref`) does. `resolve.py` is
untouched (that's #17, done) — an abandoned draft resolves VOIDED, which is
correct.

## Gate evidence

| Gate | Result |
|---|---|
| 1. `supabase db reset` | Clean — all **10** migrations incl. `*_auth_allowlist.sql` + the CI grants. |
| 2. Engine pytest | **1128 passed** (was 1121; +7 `test_auth_allowlist.py`). Nothing down. |
| 3. Lib tests | **262 passed, 0 failed**, 19 skipped (was 253; +5 unit connector, +4 integration lever — integration RAN live against the local stack). |
| 4. `tsc --noEmit` + `next build` | Both clean. New routes build: `ƒ /api/webhooks/github`, `ƒ /api/cron/reconcile-levers`, `ƒ /auth/callback`; **Proxy** registered. |
| 4b. Service-role key in bundle | **Absent from the entire `.next` build** (client + server). Grep proven by a positive control: the anon key IS in the client bundle, the service-role key is nowhere. |
| 5. DEMO-NOT-BROKEN | Local demo (`CAUSENT_LOCAL_DEMO=1`): `/impact`, `/actions`, `/data-workshop`, `/onboarding` → **200 with seed**. Guard mode (flag off): unauth `/impact`,`/actions`,`/data-workshop`,`/reports` → **307 → /login**; `/login` 200. |
| 6. #5 hook/trigger (simulated `auth.users` insert) | allowlisted → **exactly one** `viewer` membership on `ORG ca5e…d1`; second insert **no duplicate**; non-allowlisted → `enforce_allowlist` returns the 403 error (no orphan) + zero membership; email-less → safe no-op. |
| 7. #16 spine (Postgres) | draft → `levers` DRAFTED + `actions` (external_ref NULL) → paste-URL fallback → **DETECTED** + `external_ref=github:issue:128` + prediction attributed. Synthetic signed webhook: detect + **redelivery no-op** (one `transition_events` row). Mocked-poll cron: detects a missed lever + times out a stale draft. Live route smoke: bad sig → 401, no-provenance → 200 ignore, cron no-auth → 401, cron w/ secret → 200. |
| 8. Browse QA | `docs/qa/auth-connector-20260712/`: `step1-login.png`, `step5-connector-ask.png`, `step6-create-from-decision.png` (deep-link + label `causent-decision-…` + paste fallback), `step6-attributed.png` ("anchored to github:issue:128, no longer unattributed"). |

Live end-to-end (browser, demo tenant): paste → LLM decision card → commit →
Step-5 connect (`acme/orbit`) → Step-6 draft (prefilled deep-link) → paste
`…/issues/128` → **Attributed**. DB confirmed: `DETECTED`, `github:issue:128`.

## Decisions taken (and why)

1. **Hook returns an error object, not `raise exception`.** The documented
   contract returns `{error:{http_code,message}}`; GoTrue then aborts the insert
   AND surfaces the message to the client (enabling `/login?error=not_allowed`).
   A raised exception would 500 without the friendly message. Tested directly
   with the synthetic event payload (real Google login is deferred).
2. **`event->'user'->>'email'`, not `->'claims'->`.** Verified against the current
   Before-User-Created docs — the issue's draft guessed wrong.
3. **`proxy.ts`, not `middleware.ts`.** Next 16 renamed the convention; heeded the
   deprecation (AGENTS.md). Same behavior; the guard is optimistic — RLS is the
   real boundary.
4. **`getServerSupabase()` made async + split from `getServiceRoleSupabase()`.**
   Session-scoped reads in prod need Next 16's async `cookies()`; ingestion /
   webhook / cron are trusted jobs and keep the service-role client. ~11 sites
   `await`ed; query bodies unchanged.
5. **`CAUSENT_LOCAL_DEMO=1` service-role fallback.** No real Google session exists
   locally, so a session-scoped read returns zero rows. The flag keeps the demo
   green and is never set in prod — the documented runbook escape hatch.
6. **One shared demo tenant.** Invited partners are provisioned onto the seeded
   org; every partner acts in `DEMO_SCOPE_ID`. RLS still isolates strangers.
   Per-partner tenants are SEC2 (deferred).
7. **Dedup insert FIRST in the webhook.** The `(source, provider_event_id)` unique
   index — not the detector — is the idempotency authority, so a redelivery
   returns `duplicate` without re-detecting.
8. **Attribution = DETECTED, not lever-exists.** A DRAFTED lever leaves the
   prediction visibly unattributed (matches the UI + resolve.py's VOIDED-on-
   abandon path); detection is the flip.

## Scope honesty / not built

- **Drift alerting (#18) NOT built.** #16 stops at draft → create → detect →
  attribute. Live drift stays behind the design-partner mechanism-mapping test.
- **`resolve.py` untouched** (#17, done). No scorecard/ship-state (#18).
- **Live GitHub round-trip not faked.** The webhook receiver + poller are real
  code, exercised with synthetic/mocked inputs only; a real webhook/poll needs
  the GitHub App + PAT (below).
- Per-request freshness (`force-dynamic` on the dashboard) stays the #5-deferred
  P2; the dashboard pages build static, seed-at-build — fine for the demo.

## PRODUCTION SETUP REQUIRED (human console, no code)

These need a human at a console with real credentials. None are code-blocked.

### (a) Google OAuth — invite-only login (#5)
1. **Google Cloud** → new/existing project → **OAuth consent screen** in
   **Testing** mode (no verification review; up to 100 test users). Add each
   design partner's Gmail as a **Test user**.
2. **Credentials → Create OAuth client ID → Web application.** Authorized
   redirect URI = `https://<project-ref>.supabase.co/auth/v1/callback`.
3. **Supabase → Authentication → Providers → Google** → paste the Client ID +
   Secret, enable. (Or set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` /
   `…_SECRET` and flip `enabled = true` in `config.toml` for a self-hosted stack.)
4. **Supabase → Authentication → URL Configuration** → **Site URL** = the Vercel
   deploy URL; add it to the redirect allowlist.
5. **Register the Before-User-Created hook** in the Supabase Dashboard
   (Authentication → Hooks) pointing at `public.enforce_allowlist`, OR rely on
   the committed `config.toml` block for CLI-managed projects.
6. **Invite each partner:** `NODE_OPTIONS="--conditions react-server" npx tsx
   scripts/invite.ts partner@company.com` (service-role) — AND add the same email
   as a Google test user (step 1). Two allowlist layers, both required.

### (b) GitHub — read-only connector + webhooks (#16)
1. **Create a GitHub App** (Settings → Developer settings → GitHub Apps):
   permissions **Issues: Read-only**, **Metadata: Read-only**; subscribe to the
   **Issues** event. Set the **Webhook URL** =
   `https://<deploy>/api/webhooks/github` and a **Webhook secret**.
2. **Install the App** on the watch-target repo.
3. **Vercel env:** `GITHUB_WEBHOOK_SECRET` = the webhook secret;
   `CRON_SECRET` = a random string (Vercel Cron sends it as
   `Authorization: Bearer`); `GITHUB_TOKEN` = a fine-grained PAT with
   **issues:read** on the watch target (enables the reconciliation poll — until
   then the cron runs the timeout sweep only). **This PAT is the one outstanding
   project credential.**
4. The `vercel.json` cron (`/api/cron/reconcile-levers`, hourly) needs no extra
   setup beyond `CRON_SECRET`.

Until (b) lands, Step 6 is fully usable via the **paste-URL fallback** (proven
end-to-end locally) — the user creates the issue from the deep-link and pastes
its URL; detection + attribution are identical to the webhook path.

## Resume instructions

```bash
cd /Users/adamowens/Code/worktrees/coldstart-auth-connector   # or check out the branch
# .env.local (gitignored) needs: the copied main .env.local + CAUSENT_ENGINE_PYTHON,
# CAUSENT_LOCAL_DEMO=1, GITHUB_WEBHOOK_SECRET, CRON_SECRET (throwaway local values).
supabase start && supabase db reset
cd engine && /Users/adamowens/Code/causent/engine/.venv/bin/python persistence/seed_demo.py
.venv/bin/python -m pytest -q          # expect 1128 passed (use the MAIN checkout's venv)
cd .. && npm test                      # expect 262 passed (integration needs the local stack)
npx tsc --noEmit && npm run build      # clean
npm run dev                            # /login, /onboarding (funnel → Steps 5-6), /impact, /actions
```

- PR is open, base `spec/coldstart-c1-c2-c4`, **must not be merged** without
  review. On merge: close #5, keep #16 open (deep-link + paste + synthetic
  detection built; live GitHub App + webhooks + PAT pending), reconcile
  `docs/STATUS.md` (untouched tonight by design).
- NEXT per epic #13: finish #16's live wiring once the PAT lands, then C5 (#18,
  ship state + drift alert + scorecard) — still gated by the design-partner
  mechanism-mapping test for LIVE drift.
