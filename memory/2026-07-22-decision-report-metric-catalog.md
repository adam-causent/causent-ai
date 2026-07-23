# Decision Report workspace metric catalog follow-up

Date: 2026-07-22
Status: implemented locally as the Slice 8 follow-up

## Problem

The CSV dropzone previously imported into the one metric already confirmed by
the active Decision Report. A file could therefore report a successful import
while the workspace metric list stayed unchanged, and the file name could not
select or create a core metric.

## Delivered contract

- The Data Workshop now has one named metric import that requires a
  metric name, unit (`percent`, `count`, or `USD`), and a strict daily
  `date,value` CSV.
- `import_workspace_metric_csv_v1` performs workspace-scoped authorization,
  validates the payload, creates or reuses a CSV metric by name, and atomically
  upserts observations. Connector-backed and non-daily metrics cannot be
  overwritten by this path.
- The **Workspace Metrics** catalog renders every metric with an Origin column.
  A single green Add control selects it in place; there is no onboarding
  redirect and no separate data-connected badge.
- A checked workspace-scoped selection RPC persists up to five daily core
  metrics. Selected metrics appear across dashboard tabs and in the bottom
  drawer, where a working trash control removes them.
- Onboarding exposes the same multi-select without conflating it with report
  activation. One confirmed metric still owns the report's prediction.
- Data Workshop now has one named uploader. The former active-report-only
  dropzone is not rendered; entering the confirmed metric's name updates that
  series through the same checked RPC.
- The active report remains isolated for decision, action, prediction, and
  impact data. Its confirmed metric remains required and first; additional
  selected workspace metrics may appear in shared metric surfaces without
  changing the activated revision or triggering causal recomputation.

## Verification

The focused metric/import tests pass, including create, retry/update, catalog
materialization, validation, and missing-workspace authorization cases. The
full library suite passes 408 tests (362 passed, 46 intentional live/demo
skips), the complete local Supabase TypeScript integration set passes 27/27,
the expanded primary RLS file passes 29/29, and the combined primary/adversarial
RLS suite passes 37/37. TypeScript, focused ESLint,
`git diff --check`, local Supabase schema lint, and the Next.js webpack
production build pass. Local HTTP canaries return 200 for Data Workshop,
Actions, and the saved-report onboarding route.

For local acceptance, the catalog contains the two requested Gummy Alpha AI
Bot series: **Adoption Rate** (percent) and **Daily Visits** (count), each with
61 daily observations covering 2026-05-23 through 2026-07-22. Re-uploading the
same CSVs is idempotent and updates matching dates.

## Explicit boundaries

This follow-up does not change an active report's confirmed prediction metric,
add connector ingestion, automatic causal analysis, or an AI recomputation
step. Shared dashboard metric selection is intentionally separate from the
report-owned causal boundary.
