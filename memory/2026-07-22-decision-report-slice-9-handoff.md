# Decision Report Slice 9 — rollout and clean-account acceptance handoff

## Starting point

Continue Causent after the Slice 8 review branch `codex/decision-report-slice-8`. First inspect
`git status`, the current branch, recent commits, and the Slice 8 PR state. If the PR has merged,
start from updated `main`; otherwise base the Slice 9 worktree on the review branch without changing
or merging it. Preserve all unrelated files, especially the existing untracked `plugins/`
directory. Never overwrite, delete, stage, or commit `plugins/`.

Before changing code, read `AGENTS.md`, `docs/STATUS.md`, `TODOS.md`,
`docs/designs/ai-assisted-decision-report.md`, `docs/designs/decision-graph.md`,
`docs/designs/security-and-auth.md`, this handoff, and
`memory/2026-07-22-decision-report-slice-8.md`. Read the relevant Next.js 16 guides under
`node_modules/next/dist/docs/` before writing Next.js code. Check current Supabase guidance and
changelog before changing schema, auth, RLS, or Storage.

## Expected Slice 9 boundary

Derive and confirm the exact vertical slice from the living docs and current code. The accepted
next target is a controlled per-user or per-workspace rollout gate plus clean-account acceptance of
the already-built Decision Report journey. The legacy onboarding path must remain an explicit
rollback for new starts; disabling the rollout must not hide, rewrite, or corrupt durable reports
that already exist, and in-progress legacy sessions must not be migrated in place.

Browser-test the journey as a new user: generated and safe-fallback reports, direct edits and
focused questions, sparse fallback/keyboard focus, explicit save/reload and browser Back, private
image success and representative failures, named CSV metric import and multi-select, activation and
retry, manual action completion, report-native flags/filters, preliminary descriptive impact, and
feature-flag rollback. Add only the remaining Decision Report-specific adversarial generation cases
needed to reach at least nine unsupported-claim scenarios. Preserve the existing authenticated RLS,
Storage, revision, activation, metric, action-completion, and report-removal gates in CI.

Acceptance requires a reversible controlled rollout, a clean account completing the current flow
without repeated onboarding or manual database repair, durable reports surviving rollback, and
recorded partner-session evidence. Run at least three initially unassisted sessions; at least two
must pass four of five checks: decision accurate, problem accurate, evidence traceable, metric
mechanism plausible, and next action usable.

## Already complete — do not rebuild

- Slices 1–7: typed generation, provenance, deterministic gaps/edits, explicit durable revisions,
  atomic activation, report-native isolation, and strict active-report CSV ingestion.
- Slice 8: one sanitized private PNG/JPEG with scoped preview, retry-safe replace/remove, active
  lock, Storage/RLS isolation, and no original-byte retention.
- Named workspace CSV metric creation, Origin labels, up-to-five core-metric selection, onboarding
  multi-select, and working drawer add/remove behavior.
- Full-width Decision Summary, expandable numbered actions, honest GitHub/Jira handoff copy, and
  audited manual action completion.
- Recoverable report soft deletion, orphaned-report fallback filtering, `D1A1` action coordinates,
  action deep links, and 30/60/90/all plus Daily/Weekly chart controls.
- Preliminary `BEFORE_AFTER_14D` rendering for short history. It is descriptive only; ITS still owns
  causal belief and retains the 45-day-per-side confident floor.
- Schema/provenance/gap/edit tests, save/reload persistence, idempotent activation, report/asset RLS,
  and the existing integration suites.

## Non-goals

Do not redesign the lever flow, add account-level GitHub/Atlassian OAuth, add warehouse connectors,
automatically run causal computation, lower the causal floor, add hard delete/restoration, add
autosave or revision-history/export UI, ingest URLs/PDFs, add OCR, or introduce general chat. The
GitHub Actions warnings for Node.js 20-based action runtimes remain separate maintenance unless the
rollout gate directly requires CI changes.

## Verification and documentation

Verify TypeScript, focused lint, the full applicable library suite, available Supabase integration
and RLS/Storage tests, schema lint, `git diff --check`, and a Next.js webpack production build.
Browser-test both enabled and rolled-back paths with a clean local account when the stack is
available. Update `TODOS.md`, `docs/STATUS.md`, the Decision Report design, and add a dated Slice 9
memory report. Preserve unrelated files. Do not commit, push, open or merge a PR, or deploy unless
the user explicitly requests it.
