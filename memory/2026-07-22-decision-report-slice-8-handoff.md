# Decision Report Slice 8 — new-chat handoff

> Superseded on 2026-07-22: Slice 8 and its accepted follow-ups are complete on
> `codex/decision-report-slice-8`. Use
> `memory/2026-07-22-decision-report-slice-9-handoff.md` for the next task. The prompt below is
> retained only as historical scope evidence and must not be replayed.

Copy the prompt below into a new Codex chat after the Slice 7 PR is available. If Slice 7 has not merged yet, continue from `codex/ai-decision-report`; otherwise create a fresh `codex/decision-report-slice-8` branch from updated `main`.

## Prompt

Continue Causent with Slice 8: the private supplied-image path for the AI-assisted Decision Report.

First inspect `git status`, the current branch, recent commits, and open PR state. Preserve unrelated files, especially the untracked `plugins/` prototype if it is still present. Do not overwrite, discard, stage, or commit unrelated work.

Before changing code, read:

- `AGENTS.md`
- `docs/STATUS.md`
- `TODOS.md`
- `docs/designs/ai-assisted-decision-report.md`
- `docs/designs/security-and-auth.md`
- `memory/2026-07-22-decision-report-slice-7.md`
- relevant Supabase Storage/auth documentation and current changelog
- relevant Next.js 16 documentation under `node_modules/next/dist/docs/`

Plan and implement the smallest production-shaped supplied-image flow accepted by the Decision Report design:

- Accept at most one user-supplied PNG or JPEG for a durable Decision Report.
- Enforce a conservative documented byte and decoded-dimension/pixel cap before expensive work.
- Validate real magic bytes and fully decode the image on the server; never trust filename, extension, MIME type, client parsing, or embedded dimensions alone.
- Reject malformed, truncated, polyglot/ambiguous, animated, unsupported-color/profile, decompression-bomb, and oversized inputs with actionable errors.
- Strip metadata and active/untrusted payloads by decoding and re-encoding into a clean canonical PNG or JPEG. Do not preserve EXIF, GPS, comments, ICC surprises, filenames, or arbitrary original bytes.
- Store only the sanitized derivative in a private Supabase Storage bucket. Do not store the original upload.
- Bind every asset to the authenticated workspace, report, and current editable revision; prevent forged report, revision, asset, object-path, or workspace IDs.
- Use unguessable server-owned object paths. Never accept a client-provided bucket/path or expose service-role credentials.
- Add scope-bound asset metadata and RLS/Storage policies consistent with the existing membership hierarchy. Private reads must use an authenticated scoped download path or short-lived signed URL generated only after authorization.
- Make upload retry-safe and avoid orphaned objects/metadata on partial failure. Define replacement and deletion semantics explicitly, including whether detaching/deleting a report removes an unshared object immediately or schedules cleanup.
- Attach the sanitized asset through the existing `assetIds` report field and append-only revision/save boundary; do not mutate an active report or let the client promote arbitrary asset IDs.
- Render upload, processing, preview, replace, remove, and actionable failure states in the Decision Report. Preserve the existing no-image state and all Slice 1–7 behavior.
- Keep `dataClassification` descriptive only; it must not alter authorization or object visibility.
- Do not add PDF/text extraction, URL fetching, OCR, generated mock-ups, multiple files, public buckets, background media pipelines, or general file management.

Add coverage for:

- pure signature/limit/dimension validation and deterministic sanitization;
- malformed/truncated/polyglot and metadata-stripping fixtures;
- repository/server-action validation and retry/idempotency;
- authenticated member upload/read/delete and viewer/cross-workspace denial;
- forged report/revision/asset/path attempts;
- partial database/Storage failure cleanup;
- active-report edit lock and exact report reload with the authorized preview;
- UI success, replace/remove, and at least three representative failure states.

Verify with TypeScript, focused lint, the full library suite, available Supabase integration/RLS/Storage policy tests, schema lint/advisors, `git diff --check`, and a Next.js webpack production build. Browser-test successful upload/preview/removal and representative invalid-type, oversized/dimension, and unauthorized/not-editable failures when the local stack is available.

Update `TODOS.md`, `docs/STATUS.md`, `docs/designs/ai-assisted-decision-report.md`, `supabase/SCHEMA_REPORT.md` if schema/Storage contracts change, and add a dated Slice 8 memory report. Preserve unrelated files. Do not commit or push unless explicitly requested.

## Slice 7 state to preserve

Slice 7 established a strict server-only daily CSV importer and database-checked active-report metric boundary. It also made report-native metric names render without widening the legacy no-report catalog and fixed the Core Metrics empty-series state. Do not weaken those authorization, isolation, idempotency, or legacy-compatibility guarantees while adding assets.
