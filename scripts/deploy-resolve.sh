#!/bin/bash
# Deploy the resolution sweep (api/resolve.py + engine/persistence + engine/causal)
# as the STANDALONE Vercel project `causent-resolve`. This is the STATEFUL sibling
# of `causent-engine` (scripts/deploy-engine.sh): the engine function is
# credential-free, but resolution reads/writes the DB, so it lives in its own
# project and holds exactly one credential — a Postgres DSN (see api/DEPLOY.md).
#
# Why standalone (same reasons as the engine, see api/DEPLOY.md): bundling a
# Python function inside the Next.js app project sweeps node_modules/.next into
# the function bundle (>225MB cap) and the Python builder ignores excludeFiles in
# that hybrid setup.
#
# Usage:
#   scripts/deploy-resolve.sh            # preview deploy (behind team SSO wall)
#   scripts/deploy-resolve.sh --prod     # production -> https://causent-resolve.vercel.app
#
# Prereqs (see api/DEPLOY.md step "resolve"):
#   - `npx vercel login` once.
#   - On the causent-resolve project (prod + preview): CAUSENT_RESOLVE_SECRET (the
#     shared secret the app's cron sends) and DATABASE_URL (the Supabase session
#     pooler DSN — user postgres.<ref>; password via the DSN or a PG* env, never
#     committed). Optionally CAUSENT_RESOLVE_SCOPE / CAUSENT_RESOLVE_USER to point
#     the default sweep at a non-demo scope.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)/causent-resolve"
mkdir -p "$STAGE/api" "$STAGE/engine/persistence" "$STAGE/engine/causal"

cp "$REPO/api/resolve.py" "$STAGE/api/"
cp "$REPO"/engine/persistence/*.py "$STAGE/engine/persistence/"
cp "$REPO"/engine/causal/*.py "$STAGE/engine/causal/"

# Resolution needs numpy (the engine) AND psycopg (the RLS-scoped DB connection).
cat > "$STAGE/requirements.txt" <<'REQS'
numpy>=1.26
psycopg[binary]>=3.1
REQS

cat > "$STAGE/vercel.json" <<'JSON'
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/resolve.py": {
      "memory": 1024,
      "maxDuration": 60,
      "includeFiles": "engine/**"
    }
  }
}
JSON

cat > "$STAGE/pyproject.toml" <<'TOML'
[project]
name = "causent-resolve"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["numpy>=1.26", "psycopg[binary]>=3.1"]

[tool.vercel]
entrypoint = "api.resolve:handler"
TOML

cd "$STAGE"
npx vercel link --yes --project causent-resolve
npx vercel deploy "$@"
