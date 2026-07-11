#!/bin/bash
# Deploy the causal engine (api/engine.py + engine/causal) as the STANDALONE
# Vercel project `causent-engine`. See api/DEPLOY.md for why it's standalone:
# bundling the Python function inside the Next.js app project sweeps the remote
# build's node_modules/.next into the function bundle (378MB > 225MB cap), and
# the Python builder ignores excludeFiles in that hybrid setup.
#
# Usage:
#   scripts/deploy-engine.sh            # preview deploy (behind team SSO wall)
#   scripts/deploy-engine.sh --prod     # production -> https://causent-engine.vercel.app
#
# Prereqs: `npx vercel login` once; CAUSENT_ENGINE_SECRET set on the
# causent-engine project (prod + preview) — see api/DEPLOY.md step 2.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)/causent-engine"
mkdir -p "$STAGE/api" "$STAGE/engine/causal"

cp "$REPO/api/engine.py" "$STAGE/api/"
cp "$REPO"/engine/causal/*.py "$STAGE/engine/causal/"
cp "$REPO/requirements.txt" "$STAGE/"

cat > "$STAGE/vercel.json" <<'JSON'
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/engine.py": {
      "memory": 1024,
      "maxDuration": 30,
      "includeFiles": "engine/causal/**"
    }
  }
}
JSON

cat > "$STAGE/pyproject.toml" <<'TOML'
[project]
name = "causent-engine"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["numpy>=1.26"]

[tool.vercel]
entrypoint = "api.engine:handler"
TOML

cd "$STAGE"
npx vercel link --yes --project causent-engine
npx vercel deploy "$@"
