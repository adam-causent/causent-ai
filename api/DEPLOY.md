# Deploying the causal engine function (`api/engine.py`)

A stateless Vercel Python Serverless Function that wraps the causal engine's
`batch_readout`. It holds **no** database credentials — the Next.js app passes an
already-RLS-scoped daily series in as data and gets back per-`action × method` rows.

## What ships

| File | Role |
| --- | --- |
| `api/engine.py` | The function. `handler` (BaseHTTPRequestHandler) is the Vercel entrypoint; `handle_request()` is the pure, testable core. |
| `engine/causal/**` | The numpy-only engine, bundled via `vercel.json` → `functions.includeFiles`. |
| `requirements.txt` (repo root) | Python deps for the function. `numpy>=1.26` only (the engine is numpy-pure; scipy/psycopg are test-only and are **not** installed at runtime). |
| `vercel.json` | Pins `memory`, `maxDuration` (timeout guard), and `includeFiles` for `api/engine.py`. |

## Request contract

`POST /api/engine` with header `x-causent-engine-secret: <shared secret>` and a JSON body:

```json
{
  "series": [{ "date": "2025-01-01", "value": 12.3 }, "... daily, sorted, unique ..."],
  "action_dates": ["2025-02-20"],
  "methods": ["ITS", "BEFORE_AFTER_14D"]
}
```

- `series` — daily observations, strictly ascending dates; `value` may be `null` (→ NaN). Cap: **3650** points.
- `action_dates` — ship dates; each maps to an ITS intervention split. Cap: **200** actions.
- `methods` — optional; defaults to both. `ITS` (authoritative) + `BEFORE_AFTER_14D` (descriptive).

Response `200`: `{ "rows": [...], "n_actions": N, "methods": [...] }`, one row per
`action × method`. Degenerate/flat/collinear/below-floor data returns a defined
`inconclusive` row (null lift + CI, belief withheld) — never a 500, never a fabricated CI.

Guard responses: `401` (missing/wrong/unset secret), `413` (body/series/action cap),
`400` (malformed input / unknown method), `405` (non-POST).

## Deploy steps — AS DEPLOYED 2026-07-11 (standalone project `causent-engine`)

**LIVE:** `https://causent-engine.vercel.app/api/engine` (production). Smoke-tested:
GET → 405, POST without secret → `401 {"error":"unauthorized"}` (fail-closed), POST
with secret + a 120-day synthetic series → 200; ITS recovered a +50 step as lift
50.46 CI [49.3, 51.6] and correctly capped belief at 0.5 / AUTOCORRELATION on the
serially-correlated synthetic noise. The honesty guards fired on request one.

**Why standalone, not inside the Next.js app project:** deploying the repo as one
project sweeps the remote build's `node_modules` + `.next` into the Python function
bundle (378MB > the 225MB function cap), and the Python builder ignored
`excludeFiles` in that hybrid setup (verified byte-identical bundles across three
config variants). The engine therefore deploys from a minimal staged copy as its own
Vercel project — which also gives it separate scaling, logs, and secrets.

1. **Deploy** (stages api/engine.py + engine/causal + a minimal vercel.json +
   pyproject.toml, links project `causent-engine`, deploys):
   ```
   scripts/deploy-engine.sh          # preview (NOTE: behind the team SSO wall)
   scripts/deploy-engine.sh --prod   # production (publicly reachable, fail-closed)
   ```
   The `pyproject.toml` carries `[tool.vercel] entrypoint = "api.engine:handler"`
   (required by the current Python builder for BaseHTTPRequestHandler functions).
2. **Shared secret** (already set 2026-07-11): `CAUSENT_ENGINE_SECRET` lives on the
   `causent-engine` project (production + preview, Sensitive) AND on the app side in
   `.env.local` so the Next.js caller can send the header. Rotate with
   `openssl rand -hex 32` + `npx vercel env add` in a staged dir linked to
   `causent-engine` + update `.env.local`.
3. **Preview URLs are SSO-walled.** Vercel Deployment Protection covers team preview
   deployments — requests get a 302/401 to `vercel.com/sso-api` before reaching the
   function. Smoke-test against production (fail-closed by design) or use a
   protection-bypass token.
4. **Smoke-test** the live URL:
   ```
   curl -s -X POST https://causent-engine.vercel.app/api/engine \
     -H "x-causent-engine-secret: $CAUSENT_ENGINE_SECRET" \
     -H "content-type: application/json" \
     -d '{"series":[...],"action_dates":["2025-02-20"]}'
   ```
   Expect `200` with `rows`; a wrong/absent secret must return `401`.

The root Vercel project (`causent`) is the Next.js app only — `.vercelignore`
excludes `api/` + `engine/`, and the root `vercel.json` carries no function config.

## Local verification (no creds needed)

```
cd engine && CAUSENT_ENGINE_SECRET=dev .venv/bin/python -m pytest tests/test_engine_function.py -q
```
