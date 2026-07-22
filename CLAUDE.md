@AGENTS.md

# Causent repository guide

## Product

Causent connects evidence, decisions, predictions, implementation actions, and measured impact. The active product plan is the approved AI-assisted Decision Report onboarding wedge in `docs/designs/ai-assisted-decision-report.md`.

## Current stack

- Next.js 16 App Router and React 19
- TypeScript and Tailwind CSS 4
- Supabase PostgreSQL/Auth/RLS/Storage
- Anthropic API behind narrow typed seams
- Python/NumPy causal engine deployed through Vercel functions

## Actual repository layout

- `app/` — App Router pages, layouts, server actions, auth, webhooks, and cron routes
- `components/` — UI grouped by product surface
- `lib/` — typed domain logic, data access, connectors, auth, generation, and tests
- `engine/` — pure-NumPy causal engine, persistence bridge, resolution, and pytest suite
- `api/` — deployable Python Vercel functions
- `supabase/migrations/` — schema, RLS, and grants
- `docs/` — product designs, status, and verification evidence

There is no `/src` tree, LangGraph layer, Recharts/Tremor dependency, or TanStack Table dependency in the current implementation.

## Conventions

- Read the relevant guide in `node_modules/next/dist/docs/` before changing Next.js code.
- Prefer Server Components. Use Client Components only for interaction or browser APIs.
- Keep page files thin; put domain behavior in typed `lib/` modules and UI behavior in focused components.
- Preserve the existing injected-client pattern for database domain logic so it remains integration-testable.
- All user data must stay scope-bound and RLS-protected. Never expose a service-role credential to the client.
- Preserve the honesty boundary: AI may structure or suggest, but cannot invent evidence, metric observations, owners, costs, prediction magnitudes, or causal claims.
- Human users enter prediction direction, magnitude, and resolution date.
- Prefer deterministic validation and fallbacks around every model call.
- New report/action materialization must be idempotent and covered by integration tests.

## Active Decision Report boundary

- Slice 1 is implemented at `/onboarding`: `components/decision-report/` renders the compact editable report, while `lib/decision-reports/` owns the versioned schema, validation, tests, and Gummy Alpha fixture.
- Slice 2 is implemented behind the same report contract: the core AI SDK calls Vercel AI Gateway server-side, model output contains no trusted IDs, exact evidence excerpts are verified against the bounded prompt, and unsafe or failed output becomes an editable fallback. A network-enabled live Gummy Alpha telemetry run remains.
- One typed report aggregate remains the draft during onboarding.
- One final idempotent operation materializes the decision, prediction, metric relationship, and selected actions.
- Partner inputs are limited to the initial prompt, pasted supporting text, an existing metric or one metric CSV, and one re-encoded PNG/JPEG mock-up.
- Inline gap questions replace a general chatbot for the partner wedge.
- URL crawling, PDF ingestion, general chat history, background jobs, model routing, and numeric completion probability are deferred until partner validation.

## gstack skill routing

- Product discovery → `/office-hours`
- Strategy/scope → `/plan-ceo-review`
- Architecture → `/plan-eng-review`
- UI/UX plan → `/plan-design-review`
- Bugs → `/investigate`
- QA → `/qa` or `/qa-only`
- Code review → `/review`
- Shipping/deployment → `/ship` or `/land-and-deploy`
