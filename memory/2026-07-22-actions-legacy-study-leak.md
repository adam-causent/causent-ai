# Actions & Decisions legacy study leak

## Status

Done on 2026-07-22.

## Symptom

After activating a Decision Report, the Actions & Decisions tab still rendered the deterministic demo study alongside the report plan. The visible leak included the North Star objective's Key Results, legacy decisions and actions, and the persistent drawer's ARR/activation/churn charts.

## Root cause

The local MVP uses one fixed demo workspace. Decision Report activation correctly appended a report-origin decision and selected planned actions to that workspace, but the Actions page continued reading the workspace's entire legacy dataset. The UI had no boundary between rows created by the Decision Report materialization and rows created by the deterministic seed.

The browser cache was not involved. A direct database read reproduced the mixed canonical data, and a hydrated browser session reproduced the mixed rendering.

## Fix

- Read `rationale.meta.source` into the UI decision model as `decision_report` or `legacy`.
- When a workspace contains report-origin decisions, make those decisions and their linked actions the Actions & Decisions dataset and suppress the legacy objective.
- Focus the persistent Core Metrics drawer on the selected report prediction. If its metric has no connected series, render an explicit no-data state instead of falling back to unrelated demo charts.
- Preserve the original deterministic view for workspaces that do not yet contain a Decision Report plan.

## Regression coverage

`lib/data/action-plan-view.test.ts` verifies that:

1. Report plans exclude the deterministic objective and legacy rows.
2. Legacy-only workspaces retain their existing dataset.
3. The metric drawer selects the report prediction and linked actions.
4. An unconfigured report metric remains visible as an honest missing-data state.

## Verification

- `npm test`: 380 tests, 341 passed, 39 skipped, 0 failed.
- `tsc --noEmit`: passed.
- Focused ESLint: passed.
- `git diff --check`: passed.
- `next build --webpack`: passed.
- Hydrated browser QA on `/actions?selected=<report-decision-id>`: no legacy Key Results, decisions, actions, or global demo charts remained.

## Follow-up architecture note

The view boundary is appropriate for this partner MVP, but the fixed demo workspace is still a migration smell. Production should use a real project/workspace scope so legacy and report-origin projects never share canonical rows in the first place.
