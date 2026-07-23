# Decision Report Slice 8 — private supplied-image path

## Status

Prepared for review on `codex/decision-report-slice-8` on 2026-07-22. The unrelated untracked
`plugins/` directory remains untouched and is excluded from the release.

## Contract

- One supplied PNG/JPEG per durable editable Decision Report.
- Maximum input: 5 MiB, 4096×4096, and 16 megapixels. Next.js accepts an 8 MB action envelope so
  the product boundary can return its own actionable 5 MiB rejection.
- Real signature plus exact PNG IEND/JPEG EOI boundary, full fail-on-error decode, one page only,
  RGB/sRGB/grayscale only, canonical orientation/sRGB, and deterministic PNG/JPEG re-encoding.
- No original bytes, filename, EXIF/GPS, comments, ICC metadata, public URL, or client-supplied path.

## Persistence and authorization

`report_assets` binds the private Storage object to workspace, report, reservation revision, and
attachment revision. Reservation, attach, detach, and abandon RPCs re-check the actor, member rank,
current revision, and active lock. A revision trigger prevents the regular report-save RPC from
promoting an arbitrary asset ID. Private previews use an authenticated scope-checked route.

Replacement attaches the new derivative before retiring the previous asset. Removal first appends
the no-asset revision, then deletes Storage bytes. Metadata is deleted only after Storage confirms
deletion; failed cleanup remains explicitly detached for retry rather than becoming an invisible
orphan. Activation keeps the exact preview but locks replace/remove.

## UI

The Implementation section now exposes save-first guidance, upload/processing state, exact limits,
actionable failures, sanitized/private status, preview dimensions/size, replace/remove controls,
reload-safe preview, and the existing honest no-image state. Active reports render the preview
read-only.

## Verification

- TypeScript and focused ESLint passed.
- Full library suite: 400 tests, 377 passed, 23 intentional live/demo skips, 0 failed.
- Pure sanitizer coverage passed for deterministic output, metadata stripping, JPEG normalization,
  invalid signatures, truncation/trailing polyglot data, and decoded-dimension limits.
- Local report/Storage integration: 5 passed, including upload, replacement, exact reload, removal,
  forged identity denial, and arbitrary asset-promotion denial.
- Local tenant isolation/adversarial RLS: 34 passed.
- Supabase schema lint: no errors.
- Next.js 16 webpack production build passed.
- Browser acceptance passed against the production build: spoofed PNG, decoded-dimension, and
  oversized inputs showed actionable failures; valid upload rendered via the authenticated route,
  survived reload, removed cleanly, and reattached. The private preview request returned 200 and
  the final browser console was clean. Active-report mutation locking is covered by the checked
  RPC plus the existing activation lock integration suite; a fresh browser activation was not
  rerun after the final local database reset removed the demo workspace seed.
- `git diff --check` passed.

## Boundaries

No PDF/text extraction, URL fetch, OCR, generated mock-up, multiple/shared file support, public
bucket, background media job, general asset manager, CI runtime maintenance, commit, push, PR,
merge, or deployment was added.

## Same-day partner feedback addendum

The follow-up removed the Data Workshop report banner and every redundant **Add / Layer Metric**
control, renamed the catalog **Workspace Metrics**, added Origin labels, and replaced route-changing
selection with a checked in-place Add/remove flow capped at five daily metrics. Onboarding exposes
the same multi-select while the report retains one distinct prediction metric. Shared selections
appear in the drawer and tabs without widening report-owned decision or impact data.

Actions & Decisions now uses a full-width durable Decision Summary and expandable report-action
rows rather than the empty left navigation column. Each row exposes its provider reference or
no-ticket state, completion state, details, owner, and governance. A checked manual-completion RPC
allows a member to record a non-future date and explanation for a planned report action without a
GitHub push; exact retries are idempotent and viewer/cross-workspace calls are denied. Connector
copy now states that account OAuth is not present and explains configured credential, prefilled-link,
paste-attribution, and webhook monitoring behavior.

Follow-up verification is green: TypeScript, focused ESLint, `git diff --check`, Supabase schema
lint, the 408-test library suite (362 passed, 46 intentional live/demo skips), all 27 local
TypeScript/Supabase integration cases, all 29 cases in the expanded primary RLS file, and 37/37
combined primary/adversarial RLS cases. The
Next.js 16 webpack production build passes without misreporting its request-time cookie signal as
a Supabase failure; `loadDashboardData` now rethrows Next's internal control-flow errors before its
real database fallback. Local HTTP canaries for Data Workshop, Actions, and saved-report onboarding
all return 200 with the expected new states. Chrome was not relaunched after the user's crash report.

## Same-day report-history and metric-chart addendum

Decision Reports now expose a confirmed Delete report control for every lifecycle state. The
checked member-only RPC soft-deletes under a report row lock and returns the same receipt on an
exact retry. Authenticated RLS no longer exposes the removed report, revisions, or asset metadata;
private bytes and canonical decision/action audit rows are retained. Dashboard composition selects
the next live activated report and excludes orphaned report-native graph rows before legacy
fallback, so removing the last report cannot leak its actions into a workspace-wide view.

Action presentation now assigns deterministic coordinates in decision/report order (`D1A1`,
`D1A2`, ...). The coordinate appears in expandable action headers and replaces duplicate `#0`
metric flags. Each flag is a real link to `/actions?selected=<action-id>#<action-id>`, and the
target row opens on the server-rendered deep link.

The bottom drawer's former date and Daily labels are now controlled selects. Date presets cover
30, 60, 90, or all calendar days through the newest observation, while cadence switches between
daily observations and Monday-anchored weekly averages. Dynamic option labels and event filtering
follow the selected window.

Final addendum verification: TypeScript, focused ESLint, and `git diff --check` pass; the complete
library suite reports 416 tests (397 passed, 19 intentional live-model skips); scoped persistence
integration passes 4/4; combined primary/adversarial RLS passes 40/40; Supabase schema lint reports
no errors; and the Next.js 16 webpack production build passes. HTTP-only canaries return 200 for
Reports and an action deep link, render Delete report plus both chart controls, expose unique
`D1A1`–`D1A3` labels, and server-render the selected action row open. Chrome was not launched.

## Final preliminary-impact addendum

The completed action already had stored evidence, but the report-native graph reader selected only
ITS rows. Because the imported Gummy Alpha series has 46 observations before and 15 after the
action, ITS correctly remained `INSUFFICIENT_HISTORY` under the 45-day-per-side causal floor and
the UI appeared blank even though `BEFORE_AFTER_14D` existed.

The graph reader now loads both methodologies. The readout keeps causal belief unknown and the
aggregate gated, but maps the stored before/after row to a **14-day descriptive** preliminary state.
Ratio-form percentages are displayed as percentage points. The local Impact page now renders
`+3.1pp` with an overlapping-actions caveat and links the action context; it does not claim isolated
causality or lower the ITS floor. Regression coverage locks short-history evidence selection,
percent scaling, and the no-evidence state.

## Release preparation verification

- TypeScript and focused ESLint passed.
- Full library suite: 420 tests, 373 passed, 47 intentional environment/live-model skips, 0 failed.
- Live local Supabase integration: 12/12 persistence, activation, private Storage, named metric,
  core selection, import, authorization, retry, and report-removal cases passed.
- Combined primary/adversarial tenant isolation: 40/40 passed.
- Supabase schema lint at error level reported no errors.
- `git diff --check` and the Next.js 16 webpack production build passed.
