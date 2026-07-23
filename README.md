# Causent

Causent is a decision-intelligence product that connects evidence, decisions, human predictions, shipped actions, and measured impact on one causal graph.

The product has two existing loops:

- **Retrospective:** ingest a shipped action, connect it to a metric, and produce an honest Interrupted Time Series readout.
- **Prospective:** record a decision and human prediction before shipping, watch the implementation lever, and resolve the prediction against measured evidence.

The active product plan adds an **AI-assisted Decision Report** as the onboarding wedge. One initial prompt produces multiple coordinated assets: a partial report, up to three sourced proof claims, a metric hypothesis/chart, an action-plan summary, up to three draft actions, and an explicit supplied-mock-up state. Focused inline questions fill required gaps; this is structured generation, not a general chatbot.

See [docs/STATUS.md](docs/STATUS.md) for the current build state and [docs/designs/ai-assisted-decision-report.md](docs/designs/ai-assisted-decision-report.md) for the approved active plan.

## Stack

- Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4
- Supabase PostgreSQL, Auth, RLS, and Storage
- Vercel AI Gateway and the AI SDK for bounded Anthropic structured generation; Anthropic for summary polishing
- Python/NumPy causal engine deployed as Vercel functions
- Vercel application hosting

The application lives at the repository root rather than under `src/`.

## Product surfaces

- `/onboarding` — AI-assisted Decision Report onboarding with bounded live generation, durable revisions, metric/prediction activation, and a safe editable fallback
- `/reports` — saved Decision Reports with recoverable removal from visible history
- `/actions` — report Decision Summary, expandable actions, manual completion, levers, drift, and scorecards
- `/data-workshop` — named daily CSV import plus the workspace metric catalog and core selection
- `/impact` — causal readouts plus clearly labeled preliminary descriptive evidence when history is short

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

To review the Decision Report prototype without authentication:

```bash
CAUSENT_LOCAL_DEMO=1 npm run dev
```

Open `http://localhost:3000/onboarding`, select **Generate Decision Report**, and edit any report field. Slice 2 uses the Vercel AI Gateway through the core AI SDK. Authenticate locally with `VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`; override the default `anthropic/claude-sonnet-5` model with `CAUSENT_DECISION_REPORT_MODEL`. Set `CAUSENT_DECISION_REPORT_FIXTURE=1` to make the exact Gummy Alpha prompt deterministic.

The model supplies untrusted content and exact evidence excerpts, never trusted IDs. Unknown scalar claims return as `null` and unknown lists as `[]`; the server assigns IDs, verifies evidence against the brief, and materializes editable missing states for owners, customers, stakeholders, governance, and metric values. Provider failures preserve the brief in a safe editable fallback rather than dead-ending onboarding.

Slice 3 completes required gaps without another model call. The report shows at most three focused questions at a time, applies answers through the same typed reducer as direct edits, and marks the draft ready for review when Decision, Problem, one proof claim, the metric mechanism, the Action Plan summary, and one action are present. Owners, customers, stakeholders, governance, and mock-ups are explicitly optional and do not block review readiness.

Slice 4 makes the report durable. An explicit **Save draft**, **Save report**, or **Save changes** action writes a scope-bound full snapshot to append-only revisions, updates the URL with the stable report ID, and restores the exact report and metric projection on reload. Identical retries reuse the current revision and stale tabs receive a conflict instead of overwriting newer work. The validated `ReportActivationInputV1` handoff is defined but deliberately inert: saving a report creates no canonical decisions, predictions, actions, decision-action edges, or levers.

Slice 5 activates one exact reviewed revision. After saving a complete report, the user confirms an existing workspace metric, enters the human prediction direction/magnitude/resolution date, and selects one to three report actions. One checked database transaction creates one decision, one prediction, the selected planned manual actions, their decision links, and an append-only activation audit row. Identical retries return the same IDs; changed retries fail with HTTP 409. Activation creates no lever, causal edge, evidence object, tracker ticket, or impact claim. The active report becomes read-only and opens directly in **Actions & Decisions**. Report-created actions use UUID identities and a `Planned` label rather than pretending to be GitHub PRs.

Slices 6–8 carry that exact activated revision across the dashboard, ingest strict daily CSV data,
and support one sanitized private PNG/JPEG on an editable durable report. Workspace metrics can be
created from named CSV imports and independently selected for shared dashboards without changing
the report's confirmed prediction metric. Report actions can be manually completed with an audit
date/explanation, removed reports are soft-deleted from visible history, and action flags use stable
`D1A1` coordinates. Short-history before/after evidence is labeled descriptive; authoritative ITS
belief still requires at least 45 days on both sides.

To exercise the Slice 5 handoff locally, start Supabase and apply migrations before opening the app:

```bash
supabase start
supabase migration up --local
CAUSENT_LOCAL_DEMO=1 npm run dev
```

Generate or reload a report, complete the required fields, save the reviewed revision, choose a real workspace metric, enter the team prediction, select one to three actions, and choose **Activate decision**. The illustrative report chart is never copied into the human prediction or stored as metric observations.

Before changing Next.js behavior, read the relevant bundled guide under `node_modules/next/dist/docs/`; this repository uses Next.js 16 conventions that may differ from older App Router documentation.

## Verification

```bash
# TypeScript/lib tests
npm test

# Lint and production build
npm run lint
npm run build

# Supported fallback when Turbopack rejects engine/.venv symlinks
npx next build --webpack

# Python engine tests
cd engine
.venv/bin/python -m pytest -q
```

Database-backed engine/RLS/bridge tests require the local Supabase stack:

```bash
supabase start
supabase migration up --local
```

## Documentation

- [Build status and resume guide](docs/STATUS.md)
- [Active Decision Report design](docs/designs/ai-assisted-decision-report.md)
- [Prospective prediction loop](docs/designs/prospective-prediction-loop.md)
- [Decision graph](docs/designs/decision-graph.md)
- [Original retrospective wedge](docs/designs/did-it-ship-did-it-work.md)
- [Security and authentication](docs/designs/security-and-auth.md)
- [Active backlog](TODOS.md)

Historical `OVERNIGHT_REPORT*` documents are point-in-time build evidence and are intentionally not rewritten when the active plan changes.
