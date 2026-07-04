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

## Deploy steps (these need human Vercel credentials — NOT done here)

1. **Link the project** (once): `vercel link` in the repo root, or import the repo in the
   Vercel dashboard. Framework auto-detects as Next.js; `api/engine.py` is auto-detected as
   a Python function (no extra config beyond `vercel.json`).
2. **Set the shared secret** — the app and the function must agree on it:
   ```
   vercel env add CAUSENT_ENGINE_SECRET production
   vercel env add CAUSENT_ENGINE_SECRET preview
   ```
   Generate one with e.g. `openssl rand -hex 32`. The **same** value must be available to
   the Next.js caller (as `CAUSENT_ENGINE_SECRET`, server-side only) so it can send the header.
   The function fails closed (401) until this is set.
3. **(Optional) pin the Python version** — Vercel's Python runtime defaults to a recent
   3.x. To pin, add a `PYTHON_VERSION` project env var (e.g. `3.12`) per Vercel's runtime docs.
4. **Deploy**: `vercel deploy` (preview) then `vercel deploy --prod` (production).
5. **Smoke-test** the live URL:
   ```
   curl -s -X POST https://<deployment>/api/engine \
     -H "x-causent-engine-secret: $CAUSENT_ENGINE_SECRET" \
     -H "content-type: application/json" \
     -d '{"series":[...],"action_dates":["2025-02-20"]}'
   ```
   Expect `200` with `rows`; a wrong/absent secret must return `401`.

## Local verification (no creds needed)

```
cd engine && CAUSENT_ENGINE_SECRET=dev .venv/bin/python -m pytest tests/test_engine_function.py -q
```
