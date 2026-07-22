# Data Workshop metric ratio inversion

## Status

Done on 2026-07-22.

## Symptom

The legacy Data Workshop summary rendered `6/5 metrics connected` in both the summary card and the connected-metrics heading. The intended fixture state is five connected metrics out of six available.

## Root cause

The page used `metrics.length` as the connected numerator and a stale hard-coded capacity of five as the denominator. Once a sixth metric definition appeared, the display mechanically became `6/5`. The same assumption was duplicated in `ConnectedMetrics`.

## Fix

- Centralized the legacy fixture connection summary.
- Clamp the connected count to the fixture's five instrumented metrics while using the complete metric list as the total.
- Reused the summary in the card, progress ring, add/layer helper text, and connected-metrics heading.
- Made the progress ring safe when the metric list is empty.

## Regression coverage

`lib/data/metric-connections.test.ts` verifies that six available metrics render as five of six connected and that the connected count cannot exceed a smaller metric list.

## Verification

- Fresh local render contains `Connected Core Metrics (5/6)`, `5/6`, and `5 of 6 connected`.
- `npm test`: 382 tests, 343 passed, 39 skipped, 0 failed.
- TypeScript, focused ESLint, and `git diff --check`: passed.
- `next build --webpack`: passed.

## Related

This is deliberately a compatibility rule for the legacy deterministic fixture. The report-native Data Workshop should eventually derive connection state from persisted metric definitions and observations instead of a fixture baseline.
