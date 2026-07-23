# Decision Report Slice 10 — explicit iteration-series handoff

## Purpose and entry gate

Prepare a long implementation session for explicit multiple iterations of an activated Decision
Report. The current product already supports multiple independent reports and multiple append-only
revisions before activation. Slice 10 is specifically the missing post-activation loop: start a
successor from an active report, edit and activate it, then repeat without mutating prior intent or
audit history.

The contract is prepared, not implemented. The normal entry gate is recorded Slice 9 evidence from
three initially unassisted partner sessions, with at least two passing four of five usefulness checks.
If that evidence is still missing, inspect and report it before implementation. Proceed earlier only
when the user explicitly makes a product decision to override the gate; do not infer an override from
an engineering request to inspect, plan, or test.

## Starting point

Start after draft PR #28 is green and merged, or intentionally stack on its head only when the user
explicitly asks for a stacked change. First inspect `git status`, branch, recent commits, remote
tracking, PR state, checks, and review comments. Preserve unrelated changes and never stage, modify,
delete, or commit `plugins/`.

Read completely before changing code:

- `AGENTS.md`
- `TODOS.md`
- `docs/STATUS.md`
- `docs/designs/ai-assisted-decision-report.md`
- `docs/designs/decision-graph.md`
- `docs/designs/security-and-auth.md`
- `supabase/SCHEMA_REPORT.md`
- `memory/2026-07-22-decision-report-slice-9.md`
- this handoff
- the relevant Next.js 16 guides under `node_modules/next/dist/docs/`

Before schema, RLS, or Storage work, verify the current Supabase guidance. Derive final names from the
existing migrations and repositories; the names below define behavior, not an obligation to use a
particular table spelling.

## Existing invariants to preserve

- `decision_report_revisions` are append-only full snapshots with stale-base conflict detection and
  identical-save reuse.
- An `active` report is immutable and points to exactly one activation, decision, prediction, metric,
  and reviewed revision.
- Activation is atomic and idempotent. It creates one new canonical intent set or none; a changed
  retry conflicts.
- Report-native Actions, Impact, metrics, and readouts cannot leak across project boundaries.
- Private assets belong to one report and revision lineage. Original bytes, filenames, metadata,
  public URLs, and client-owned Storage paths are never retained.
- Soft deletion hides report/revision/asset surfaces without destroying canonical audit history.
- Unsupported content never becomes `sourced`; iteration does not relax provenance rules.

## Locked Slice 10 boundary

Model an explicit linear series, not an editable active row.

1. Every existing report is backfilled into a one-report series. A report records its series,
   one-based iteration number, optional direct predecessor, and the human-entered reason for creating
   the iteration. The series records its explicit current active report, if any.
2. A checked, security-definer, idempotent start operation locks the series and active parent. It
   requires member access, a non-deleted active parent, and no non-deleted direct successor, then
   creates exactly one draft successor and revision 1.
3. The successor snapshot begins from the parent's exact activated revision. Preserve immutable
   claim and draft-action source IDs for unchanged logical items so comparisons remain stable. Give
   the report and revision new identities. Strip `implementation.assetIds` before validation because
   the asset trigger correctly forbids cross-report asset identity; the UI explains that an image
   must be reattached.
4. The parent remains the series' operational report while the successor is draft or ready. Existing
   tabs must continue resolving through the explicit current pointer during that work.
5. Activating the successor uses the existing activation checks to create new decision, prediction,
   and selected action rows. In the same transaction, advance the series current pointer from the
   expected parent to the child. A stale parent pointer or changed retry conflicts; an exact retry
   returns the original child activation.
6. Previous reports, revisions, activations, decisions, predictions, actions, evidence, and impact
   rows remain unchanged. Historical action completion is not automatically copied, canceled, or
   reopened.
7. Reports groups iterations into a readable linear timeline, labels current/draft/historical state,
   and offers **Start next iteration** only for the current active report. Direct links continue to
   open every non-deleted iteration.
8. Removing a draft successor leaves the current pointer unchanged and permits a new successor.
   Removing the current active successor moves the pointer only to the nearest non-deleted active
   predecessor in the same series, or to null. The confirmation copy must state this outcome. Never
   fall through to another report series based on sort order.

## Suggested implementation sequence for a long session

### Iteration A — contract and migration

- Write pure lineage/current-selection tests first, including three iterations, a draft child, a
  removed child, and two unrelated series.
- Add the series/lineage migration, backfill, constraints, indexes, RLS, and explicit grants.
- Add the checked start RPC with a required trimmed reason, exact-retry reuse, changed-retry conflict,
  and row locks. Make the partial uniqueness rule ignore soft-deleted successors.
- Extend primary and adversarial RLS tests before UI work.

Checkpoint: a member can create exactly one isolated draft successor; a viewer/cross-workspace actor
cannot; the active parent and all canonical tables are byte-for-byte unchanged.

### Iteration B — repository and activation seam

- Add typed repository inputs/results and integration tests for start/retry/stale/deleted cases.
- Extend load/index models with series, predecessor, iteration, reason, and explicit-current identity.
- Update activation so advancing the current pointer is part of the same transaction as canonical
  materialization. Preserve v1 retry behavior and do not create a second activation path in app code.
- Replace `updated_at`-based current-project inference with a pure selector over the explicit series
  current pointer. Cover multiple unrelated active series without leaking one into another; retain
  the existing single-project product boundary rather than inventing a project switcher.

Checkpoint: activating iteration 2 leaves iteration 1 intact, advances current exactly once, and all
report-native loaders select iteration 2 through an explicit identity.

### Iteration C — Reports and editor journey

- Group the Reports index by series and show iteration number, status, reason, and current marker.
- Add the current-only **Start next iteration** confirmation/form and route directly to the new draft.
- Explain that the prior report stays live until activation and that its private image is not copied.
- Reuse the existing editor, focused gaps, explicit save, metric confirmation, prediction, and
  activation UI. Do not add chat, autosave, or a parallel editor.
- Update deletion copy and behavior for draft and current-active successors.

Checkpoint: a browser can create, edit, save/reload, activate, and revisit iteration 2 while iteration
1 remains readable and unchanged.

### Iteration D — three-cycle acceptance and cleanup

- Repeat through iteration 3 and verify iteration 3 can start iteration 4 without special cases.
- Exercise an exact start retry, a changed-reason retry, stale activation, deleted draft replacement,
  current iteration removal, browser Back, direct links, and feature-flag rollback.
- Verify supplied-image reattachment succeeds on a successor and no Storage object/path is shared.
- Verify Actions & Decisions, Data Workshop, and Impact resolve only through the explicit current
  active report; historical rows remain auditable but do not enter the current aggregate.
- Run TypeScript, focused lint, the complete library suite, Supabase integration/RLS/Storage tests,
  a clean database reset, schema lint, engine/bridge tests, `git diff --check`, the Next.js 16 webpack
  production build, and browser console checks.
- Reconcile `TODOS.md`, `docs/STATUS.md`, the design, schema report, and a dated Slice 10 memory report.

Checkpoint: three sequential activated iterations pass with no duplicate reports, revisions,
activations, or canonical graph rows and no cross-series/current-project ambiguity.

## Required adversarial cases

- Cross-workspace parent ID and a same-workspace viewer both fail without revealing existence.
- A stale or non-current parent cannot create the next iteration.
- Concurrent identical starts return one successor; concurrent changed starts produce one winner and
  one conflict.
- A deleted parent, deleted series current, or active report from another series cannot be selected.
- A forged predecessor, series ID, iteration number, asset ID, revision ID, metric ID, or action
  source ID cannot cross the checked boundary.
- A successor activation cannot move the pointer unless its direct parent is the expected current
  report, and transaction failure leaves both pointer and canonical graph unchanged.
- Soft deletion cannot cause sort-order fallback into another series.
- Copied unsupported claims retain their prior status and source references; iteration creation never
  upgrades provenance.

## Acceptance gate

The vertical slice is complete only when one clean account performs:

```text
active iteration 1
  -> start/edit/save/activate iteration 2
  -> start/edit/save/activate iteration 3
  -> start/edit/save/activate iteration 4
```

At every step, the preceding active report stays operational until the successor activation commits;
the current pointer changes atomically; prior canonical rows and private assets remain unchanged;
Reports preserves the lineage; report-native tabs use only the explicit current report; and exact
retries remain duplicate-free. Automated evidence does not replace the Slice 9 partner gate.

## Non-goals

Do not add branching/merge semantics, in-place active-report edits, prior-row rewrites, automatic
action cancellation or migration, cross-report Storage reuse, model regeneration, general chat,
revision diff/restore/export, hard deletion, OAuth, connectors, URL/PDF/OCR ingestion, autosave,
automatic causal recomputation, a lower statistical confidence floor, Completion Outlook, or a
multi-project workspace switcher.
