@AGENTS.md
# Causent — AI Decision Intelligence Platform

## Project
Causent helps product and business leaders make better decisions through 
AI-powered analysis and structured decision workflows.

## Stack
- Framework: Next.js 14+ (App Router, TypeScript)
- Styling: Tailwind CSS
- Auth + DB: Supabase (PostgreSQL)
- Hosting: Vercel
- AI: Anthropic API (Claude) via LangGraph agents
- Charts: Recharts / Tremor
- Tables: TanStack Table

## Architecture
- /src/app — App Router pages and layouts
- /src/components — Reusable UI components
- /src/lib — Supabase client, utilities, helpers
- /src/agents — LangGraph agent definitions
- /src/types — Shared TypeScript types

## Conventions
- Use Server Components by default; add 'use client' only when needed
- All Supabase queries go through /src/lib/supabase.ts
- Prefer named exports over default exports for components
- Keep components small and composable
- No logic in page files — delegate to components and lib functions

## gstack
Use /browse skill from gstack for all web browsing.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, 
/plan-design-review, /design-consultation, /review, /ship, /qa, /cso, 
/retro, /investigate
## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
