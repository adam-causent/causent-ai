# Decision Report Slice 6 — report-native dashboard isolation

## Status

Implemented on `codex/ai-decision-report` on 2026-07-22.

## Problem

Slice 5 activated a reviewed Decision Report into canonical decisions, predictions, and planned actions, but the surrounding dashboard still treated the fixed demo workspace as the project. Only Actions & Decisions had a local filter. Data Workshop, Reports, Impact, and the persistent Core Metrics drawer could still expose deterministic study data that did not belong to the report.

The tracker backend and Jira/GitHub connector UI already existed, but the report-origin decision stopped before that established lever workflow.

## Implementation

- Added a runtime-validated database index over `decision_reports` and their current append-only revisions.
- Made the newest activated report's canonical decision, selected actions, and confirmed metric the shared dashboard project boundary.
- Applied that boundary before the persistent shell and individual tabs render, suppressing unrelated objectives, metrics, actions, reports, and aggregate impact.
- Added a Decision Report-native Reports index and compact preview with a stable full-report link.
- Made Data Workshop connection counts reflect the report metric's actual observation series rather than the legacy fixture ratio.
- Made Impact columns dynamic and report-scoped, including honest planned-action references and no inherited workspace-wide improvement rate.
- Mounted the existing Jira/GitHub lever flow for an unattributed report decision. No new connector backend or credential behavior was introduced.
- Preserved the complete deterministic dashboard when no activated Decision Report exists.

## Boundaries

This slice does not implement CSV parsing or ingestion, private file storage, metric creation, evidence generation, causal claims, connector credentials, or multi-report project switching. The current project boundary is the newest activated report in the workspace.

## Verification

- TypeScript: passed.
- Focused ESLint: passed.
- Library suite: 384 tests, 345 passed, 39 environment/live skips, 0 failed.
- Next.js 16 webpack production build: passed.
- `git diff --check`: passed.
- Database-backed tests skipped honestly because the local Supabase stack was unavailable.

## Preserved work

The unrelated untracked `plugins/` directory was not modified or staged.
