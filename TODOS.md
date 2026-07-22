# Causent active backlog

Last reconciled: 2026-07-21. Completed historical work is documented in `docs/STATUS.md` and the overnight reports. This file contains only active or deliberately deferred work.

## P0 — AI-assisted Decision Report partner wedge

Approved design: `docs/designs/ai-assisted-decision-report.md`.

### Completed Slice 1 — interaction prototype

- [x] Lock the versioned `DecisionReportV1` schema, five claim/provenance states, runtime validation, and the three-action ceiling.
- [x] Add the Gummy Alpha golden prompt, complete three-section report, metric hypothesis, 40% illustrative baseline, and 55% founder prediction.
- [x] Replace `/onboarding` with the deterministic prompt-to-report flow while retaining the legacy funnel code for rollback.
- [x] Build compact focused editors for Decision, Supporting Evidence, Implementation, actions, owners, governance, and visible missing fields.
- [x] Add contract tests for the golden fixture, sourced-claim requirements, missing-claim honesty, and action cardinality.

### Completed Slice 2 — live report generation

- [x] Define a model-output DTO that contains content and evidence excerpts but no trusted claim or action IDs.
- [x] Generate and validate the three prescribed sections from arbitrary bounded prompt text through a server-only Vercel AI Gateway seam.
- [x] Assign immutable claim/action IDs server-side and accept a sourced claim only when its evidence excerpt matches the supplied prompt.
- [x] Reject unsupported numeric claims and leave owners, customers, stakeholders, governance, and metric values missing unless sourced.
- [x] Preserve the deterministic Gummy Alpha fixture as an explicit development mode and provider-failure fallback; preserve arbitrary briefs in a safe partial fallback.
- [x] Add timeout, refusal, malformed-output, unsupported-claim, and retry-once tests.
- [x] Live-validate the Gummy Alpha prompt through `anthropic/claude-sonnet-5`: one attempt,
  24,412 ms, 4,309 input tokens, 2,967 output tokens, 7,276 total tokens, and six actions.
  Provider-wrapped structured output is normalized only when the recovered report passes the
  complete runtime contract. This was the pre-optimization six-action baseline.

### MVP latency reduction

- [x] Cap the report at three supporting proof claims and three actions.
- [x] Remove Alternatives, Relevant Precedent, and Estimated Cost from the MVP report and model contract.
- [x] Return `null`/`[]` for unknown model values, then materialize explicit editable `missing` states server-side.
- [x] Reduce the output ceiling from 4,500 to 2,200 tokens while preserving the safe fallback.
- [x] Re-run the live Gummy Alpha benchmark against the reduced contract: one attempt,
  13,852 ms, 3,873 input tokens, 1,598 output tokens, 5,471 total tokens, three proof claims,
  and three actions. Unsupplied customers, stakeholders, and data sources materialized as
  explicit `missing` states.

### Completed Slice 3 — focused gap completion and typed edits

Goal: help the user finish the partial report without adding chat infrastructure or another model call.

- [x] Add a pure `scanDecisionReportGaps(report)` function with stable priority: Decision, Problem, at least one proof claim, Core Metric mechanism, Action Plan summary, then at least one action.
- [x] Define the smallest `ReportEditCommandV1` reducer used by both direct field edits and focused answers. Commands may replace/confirm claim text, edit action title/summary/owner, add an action up to the three-action ceiling, and set data classification.
- [x] Render a compact “Complete this report” panel with at most three open questions and focus the corresponding report field when selected.
- [x] Mark user answers `user_confirmed`, preserve immutable claim/action IDs, and recompute gaps locally without another AI request.
- [x] Replace the inert final-review behavior with an explicit ready/not-ready state. Optional customers, stakeholders, owner, governance, and mock-up fields do not block readiness.
- [x] Add unit tests for gap ordering, optional missing fields, command validation, the three-action ceiling, ID preservation, direct-edit/question parity, and completing the safe fallback to ready.
- [x] Browser-review the live Gummy Alpha report and the ready-state transition. The review caught and fixed a contradiction where optional owners, customers, and stakeholders appeared required beside a “Decision Report ready” message.
- [ ] Complete the remaining browser acceptance pass for the sparse safe fallback and keyboard focus before the partner session.

Acceptance: the safe fallback can be completed into a report-ready draft; the Gummy Alpha report is already ready or names only real required gaps; direct editing and answering a focused question produce the same validated report state.

Non-goals: report persistence, refresh/Back recovery, general chatbot/history, metric or CSV handoff, uploads, final graph materialization, and connector work.

### Completed Slice 4 — durable report revisions and approval boundary

Goal: make the reviewed Decision Report durable and retry-safe without prematurely writing the canonical decision graph.

- [x] Add `decision_reports` and `decision_report_revisions` with scope-bound RLS and explicit grants. Revisions are append-only full `DecisionReportV1` snapshots with author, timestamp, base revision, and a database-owned deterministic content hash.
- [x] Add injected-client repository functions to create a report, append a revision, and load its current revision. Identical saves reuse the existing revision; a stale base revision returns an immediate HTTP 409 conflict with the current revision ID.
- [x] Bind generation and persistence server actions to the authenticated session and scope, then validate all client payloads at runtime. Save only on explicit user action; no per-keystroke autosave was added.
- [x] Add `Saved`/`Unsaved` UI state and explicit **Save draft**, **Save report**, and **Save changes** actions. The stable `?report=<id>` route reloads the exact report snapshot and metric projection.
- [x] Define and validate a pure, inert `ReportActivationInputV1` containing the report/revision IDs, confirmed metric ID, human prediction fields, and one to three selected action source-item IDs.
- [x] Integration-test cross-workspace denial, read-only report tables, append-only revisions, identical-save idempotency, stale-revision conflicts, schema/readiness rejection, exact reload, and zero canonical graph writes.

Acceptance: a ready Gummy Alpha report persists once; an identical retry creates no revision; one real edit creates one revision; another workspace cannot read or write it; reload restores the same report; and the slice creates zero `decisions`, `predictions`, `actions`, `decision_actions`, or `levers`.

Verification: the live local Supabase repository test passes both cases in roughly 250 ms; the RLS isolation suite passes 19/19; TypeScript, targeted lint, all 368 library tests, the Supabase schema linter, and the webpack production build pass. Manual UI acceptance remains part of the partner pass.

Non-goals: sources/assets/uploads, Data Workshop or CSV handoff, human-prediction UI, canonical materialization, connectors, and per-keystroke autosave.

### Completed Slice 5 — reviewed-report activation bridge

Goal: let one saved Decision Report produce several canonical assets without allowing duplicate or partial graph writes.

- [x] Add a three-part activation panel for real metric confirmation, a blank human prediction commitment, and selection of one to three generated actions.
- [x] Keep the illustrative metric chart separate from the commitment: it never pre-fills direction, magnitude, resolution date, or metric observations.
- [x] Add `decision_report_activations` as a scope-bound, read-only audit table and add the `active` report state plus canonical identity pointers.
- [x] Add one checked `activate_decision_report_v1` transaction that validates the exact reviewed revision, workspace metric, human prediction, and selected source-item IDs before creating one decision, one prediction, planned manual actions, and decision-action links.
- [x] Make exact retries return the same activation/decision/prediction/action IDs; return an immediate HTTP 409 when a retry changes the activation inputs.
- [x] Lock active reports against later revision saves. Activation failures leave the complete `report_ready` revision intact with zero partial canonical rows.
- [x] Hand off to `/actions?selected=<decision_id>` and render report-created actions with collision-free UUID identities plus a `Planned` reference instead of a fake GitHub PR number.
- [x] Keep lever creation, tracker tickets, causal edges, evidence, and impact claims outside activation.
- [x] Verify live atomic creation, exact retry reuse, changed-retry conflict, invalid-action rollback, cross-workspace metric rejection, zero levers, active-report reload, and edit locking. Expand the authenticated RLS gate to 22 passing cases.

Acceptance: a saved reviewed Gummy Alpha report requires explicit human metric/prediction/action choices; activation creates the intended canonical rows exactly once; retry and failure paths create no duplicates or partial plan; the user lands on the selected decision in Actions & Decisions.

Non-goals: metric creation, CSV ingestion, source/assets/uploads, connectors, tracker ticket creation, lever selection, causal impact, Completion Outlook, and per-keystroke autosave.

### Work after Slice 6

### Completed Slice 6 — report-native dashboard isolation and connector handoff

Goal: make an activated Decision Report the visible project boundary throughout the dashboard and continue its plan into the existing tracker workflow.

- [x] Load durable Decision Reports and current revisions into the dashboard through runtime validation.
- [x] Use the newest activated report's canonical decision, selected actions, and confirmed metric as the shared dataset for Core Metrics, Data Workshop, Actions & Decisions, and Impact.
- [x] Suppress workspace-wide objectives, metrics, actions, impact aggregates, and legacy report fixtures once the report project boundary is active.
- [x] Index saved Decision Reports in Reports with a compact native preview and stable link back to the full report.
- [x] Carry the existing Jira/GitHub create, read-only deep-link, and paste-attribution UI into a report-origin decision until a lever is linked.
- [x] Preserve the complete legacy dashboard for workspaces without an activated Decision Report.
- [x] Add pure regression coverage for report isolation and run TypeScript, focused lint, all 384 library tests, diff checks, and the webpack production build.

Acceptance: after report activation, no deterministic study metric, objective, action, impact aggregate, or stakeholder-report fixture appears in the report project; the confirmed metric and selected planned actions remain visible across tabs; Reports shows the saved Decision Report; and Actions & Decisions offers the established GitHub/Jira lever flow.

- Add private Storage handling for one size-capped PNG/JPEG: magic-byte validation, decode/re-encode, scoped read, deletion, and failure states.
- Add a real metric-creation/CSV ingestion path in Data Workshop; Slice 6 isolates the confirmed metric but does not add ingestion writes.
- Keep lever creation as a subsequent explicit action-selection step.
- Feature-flag the new onboarding per user/workspace; preserve legacy onboarding as rollback.

### Persistence and materialization

- Preserve state through refresh and Back; consider autosave only after explicit-save behavior is reliable.
- Expand Reports from the current report-native index/preview only if partner use requires revision history or export.

### Partner verification

- Unit-test schema, provenance invariants, gap ordering, and typed edits.
- Integration-test asset access when the supplied-image path lands; report RLS, snapshots, and idempotent materialization are covered.
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
- Add revision-history and export surfaces only if report-index partner use calls for them.
- Finish inert destinations only when their flows exist: New Project, Settings, manual action, and credentialed connector controls.
- Make `LineTimeSeries` x-axis tick density viewport-aware.
- Resolve the duplicate “Core Metrics Summary” heading on Data Workshop when the drawer is open.
- Increase mobile header touch targets if mobile becomes a supported primary surface.
- Tune the demo Gross Profit generator only if changing the documented verification baseline is worthwhile.

## P3 — Deferred scale work

- Full-history GitHub backfill worker with resumable cursors and rate-limit backoff.
- Warehouse connectors such as Postgres/BigQuery after a real partner request.
- Graph-scale policies for thousands of actions and edges.
