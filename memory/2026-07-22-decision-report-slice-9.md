# Decision Report Slice 9 — controlled rollout and local acceptance

## Status — 2026-07-22

Implemented and verified from Slice 8 commit `95c3c07`, then prepared as the Slice 9 update to
draft PR #28. The PR remains a review boundary; no merge or production deployment is part of this
slice.

The engineering boundary is complete. The release gate is not: three real initially unassisted
partner sessions are still required, and at least two must pass four of five usefulness checks.

## Rollout contract

- `decision_report_rollouts` stores an operator-managed `(scope_id, user_id)` assignment because
  current design partners share one seeded workspace.
- RLS permits an authenticated user to read only their own assignment when they also hold workspace
  access. Authenticated roles receive no insert, update, or delete grant, so partners cannot enroll
  themselves or change rollback state.
- Unassigned or lookup-failure users default to legacy onboarding.
- `/onboarding` canonicalizes new starts to `?flow=legacy` or `?flow=decision-report`.
- `?flow=legacy` is sticky across refresh, browser Back, and later assignment enablement. No
  in-progress legacy session is migrated in place.
- Disabling rollout sends new and unsaved Decision Report starts to legacy. It does not allow an
  explicit `flow=decision-report` URL to bypass rollback.
- A valid `?report=<id>` always selects Decision Report, independent of rollout state, so durable
  draft, ready, and active reports stay visible and unchanged.
- `CAUSENT_DECISION_REPORT_LOCAL_ROLLOUT=1` is a local-demo test switch only.

## Rollback criteria

Disable a partner assignment when the new-start path repeatedly fails generation, cannot preserve
an explicit save/reload, repeats onboarding after activation, requires manual database repair, or
labels unsupported evidence as sourced. Rollback affects routing for new starts only. Do not delete,
rewrite, migrate, or unlock existing reports or their materialized graph rows.

## Browser acceptance evidence

One clean local database reset plus the standard demo workspace seed was used. This proves a new
Decision Report journey with no pre-existing report; it is not represented as an independent human
partner session or a production-auth account.

- Enabled new start canonicalized to `?flow=decision-report`.
- Live Gummy Alpha generation completed in 13.9 seconds with no console errors.
- A direct Problem edit saved to report `780203a1-ebe4-480b-b687-b32477972d13`, survived reload,
  and survived navigation to Data Workshop plus browser Back.
- Invalid PNG produced an actionable rejection; a valid sanitized private PNG rendered through the
  authenticated asset route and survived reload.
- `Slice 9 Clean Metric` imported 30 daily CSV rows and was selected in place as the core metric.
- Activation created the report-native decision/action once and handed off to Actions & Decisions.
  Existing integration coverage verified exact retry reuse and changed-retry rejection.
- Manual completion recorded 2026-07-22 plus an explanation and survived the server round trip.
- Impact showed no fabricated number: the planned action rendered `—`, the aggregate remained
  `0 / 0 confident readouts`, and the 45-day ITS caveat remained visible. Existing regression
  coverage continues to verify preliminary descriptive evidence when such stored evidence exists.
- With rollout disabled, `/onboarding` and an explicit `flow=decision-report` start resolved to
  `?flow=legacy`; the active saved report still loaded directly with its private asset.
- After re-enabling rollout, an existing `?flow=legacy` URL remained legacy.
- A sparse arbitrary live report exposed two focused gaps. “Edit in report” focused the exact
  missing textarea, Tab continued to the next editable field, and focused answers reached ready
  without another generation request.
- A deliberately invalid model identifier forced the deterministic arbitrary-prompt fallback. The
  original brief remained sourced while all six required fields remained visibly incomplete.

## Unsupported-claim gate

Nine Decision Report-specific scenarios now attempt to fabricate evidence for the decision,
background, problem, proof claim, metric mechanism, action-plan summary, owner, customer, and
stakeholder. Every case remains inferred/suggested/missing and none can become `sourced`.

## Verification

- TypeScript: passed.
- Focused ESLint: passed.
- Library suite: 426 tests; 379 passed, 47 intentional environment/live-model skips, 0 failed.
- Focused local Supabase/Storage integrations: 24/24 passed.
- Primary plus adversarial RLS isolation: 41/41 passed, including self-only rollout reads and
  denied authenticated mutation.
- Full Python engine/bridge suite: 1,177/1,177 passed.
- Supabase clean-slate migration reset: passed.
- Supabase schema lint at error level: passed.
- Next.js 16 webpack production build: passed.
- Browser consoles: clean across enabled, fallback, activation, Impact, and rollback paths.
- `git diff --check`: passed.

## Remaining release gate

Run at least three real initially unassisted partner sessions. Record facilitator intervention,
abandonment, time to completion, and the five checks: decision accurate, problem accurate, evidence
traceable, metric mechanism plausible, next action usable. At least two sessions must pass four of
five. Do not infer this result from automated acceptance and do not expand into later roadmap work
before the gate passes.
