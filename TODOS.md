# Causent active backlog

Last reconciled: 2026-07-21. Completed historical work is documented in `docs/STATUS.md` and the overnight reports. This file contains only active or deliberately deferred work.

## P0 — AI-assisted Decision Report partner wedge

Approved design: `docs/designs/ai-assisted-decision-report.md`.

### Completed Slice 1 — interaction prototype

- [x] Lock the versioned `DecisionReportV1` schema, five claim/provenance states, runtime validation, and the seven-action ceiling.
- [x] Add the Gummy Alpha golden prompt, complete three-section report, metric hypothesis, 40% illustrative baseline, and 55% founder prediction.
- [x] Replace `/onboarding` with the deterministic prompt-to-report flow while retaining the legacy funnel code for rollback.
- [x] Build compact focused editors for Decision, Supporting Evidence, Implementation, actions, owners, governance, and visible missing fields.
- [x] Add contract tests for the golden fixture, sourced-claim requirements, missing-claim honesty, and action cardinality.

### Slice 2 — live report generation

- [x] Define a model-output DTO that contains content and evidence excerpts but no trusted claim or action IDs.
- [x] Generate and validate the three prescribed sections from arbitrary bounded prompt text through a server-only Vercel AI Gateway seam.
- [x] Assign immutable claim/action IDs server-side and accept a sourced claim only when its evidence excerpt matches the supplied prompt.
- [x] Reject unsupported numeric claims and leave owners, customers, stakeholders, costs, governance, and metric values missing unless sourced.
- [x] Preserve the deterministic Gummy Alpha fixture as an explicit development mode and provider-failure fallback; preserve arbitrary briefs in a safe partial fallback.
- [x] Add timeout, refusal, malformed-output, unsupported-claim, and retry-once tests.
- [ ] Run the live Gummy Alpha evaluation in a network-enabled environment and record latency/token usage. The UI already captures both; local outbound DNS was unavailable on 2026-07-21.

### Remaining contract and materialization work

- Lock gap ordering and typed edit commands.
- Inspect the current onboarding writes and define the one final idempotent materialization operation.

### Report persistence and security

- Add report, report-revision, source, and asset persistence with scope-bound RLS and explicit grants.
- Store append-only full snapshots for the partner wedge.
- Add private Storage handling for one size-capped PNG/JPEG: magic-byte validation, decode/re-encode, scoped read, deletion, and failure states.
- Feature-flag the new onboarding per user/workspace; preserve legacy onboarding as rollback.

### Inline assistance after Slice 2

- Implement deterministic gap ranking and inline focused questions. Do not build general chatbot or chat-history infrastructure.

### Persistence and materialization

- Autosave draft snapshots and preserve state through refresh and Back.
- Reuse existing metric selection/CSV and human prediction commitment behavior.
- Materialize the canonical decision, prediction, metric relationship, and selected actions once after final approval.
- Make retries idempotent and verify double-submit creates zero duplicates.
- Store the approved report in Reports and surface the created work in Actions & Decisions.

### Partner verification

- Unit-test schema, provenance invariants, gap ordering, and typed edits.
- Integration-test RLS, snapshots, asset access, and idempotent materialization.
- Browser-test partial generation, direct edits, inline questions, metric confirmation, approval, retry, refresh, Back, and feature-flag rollback.
- Add at least nine adversarial unsupported-claim scenarios.
- Run at least three initially unassisted partner sessions; require at least two to pass four of five checks: decision accurate, problem accurate, evidence traceable, metric mechanism plausible, next action usable.

Estimated for the current builder profile: 3–5 calendar weeks at 15–25 focused hours per week. First interactive report target: roughly one week. End-to-end partner target: roughly 2–3 weeks.

## P1 — Existing production operations

- Arm `causent-resolve`: set the Supabase session-pooler `DATABASE_URL` on the `causent-resolve` Vercel project, then redeploy `causent-resolve` and `causent-ai`.
- Decide whether to enable automated connector reconciliation. It currently fails closed because `SUPABASE_SERVICE_ROLE_KEY` is intentionally absent from Vercel; paste attribution remains available.
- If Jira automation is needed, configure `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_WEBHOOK_SECRET`, and the Jira webhook.
- If GitHub issue auto-create is needed, configure a write-scoped `GITHUB_WRITE_TOKEN`; the existing token is read-only.
- Add `app/robots.ts` and the appropriate proxy behavior if `/login` should not be indexed.

## P1 — Product validation outside the Decision Report

- Run the existing zero-code mechanism-mapping test with the design partner before building the webhook-driven `LEVER_DROPPED` drift-alert surface.
- Use the seeded baseline-drift beat as the prop and capture whether the partner recognizes the event, how often it occurs, and what notification would change behavior.

## Conditional production ramp

Only begin these after the Decision Report partner gate passes:

- Bounded single-page URL retrieval with SSRF, redirect, byte, and timeout protection.
- Text/PDF ingestion in a secret-free bounded extraction runtime.
- Malware scanning/quarantine for broader file types.
- Conversational delivery as another client of the report schema, gap scanner, and typed commands.
- Richer revision/reapproval workflows for editing active reports.
- Model routing, extraction caching, or selective model tiers after measured cost/latency evidence.
- Numeric Completion Outlook after defining auditable inputs and calibration.
- Automated governance enforcement.

## P2 — Existing architecture and UX debt

- Replace remaining demo service-role dashboard reads with per-request `@supabase/ssr` RLS clients where live freshness is required.
- Add dynamic rendering or explicit revalidation to dashboard routes that must reflect per-request data.
- Persist reports from the database; the current dashboard DB path still returns an empty reports collection.
- Finish inert destinations only when their flows exist: New Project, Settings, manual action, and credentialed connector controls.
- Make `LineTimeSeries` x-axis tick density viewport-aware.
- Resolve the duplicate “Core Metrics Summary” heading on Data Workshop when the drawer is open.
- Increase mobile header touch targets if mobile becomes a supported primary surface.
- Tune the demo Gross Profit generator only if changing the documented verification baseline is worthwhile.

## P3 — Deferred scale work

- Full-history GitHub backfill worker with resumable cursors and rate-limit backoff.
- Warehouse connectors such as Postgres/BigQuery after a real partner request.
- Graph-scale policies for thousands of actions and edges.
