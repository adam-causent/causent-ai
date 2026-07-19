"""Deploy-ready Vercel Python function that runs the resolution sweep.

This is the STATEFUL sibling of api/engine.py. Where the engine function is
deliberately credential-free (the Next app passes it a series; it holds no DB
creds), resolution is inherently stateful: it reads predictions/levers/metrics,
materializes the lever edge through the REAL bridge, and writes verdicts back.
So it lives in its OWN Vercel project (`causent-resolve`, deployed via
scripts/deploy-resolve.sh) — never folded into the credential-free engine — and
it holds exactly one credential: a Postgres DSN it connects RLS-scoped through.

Why a serverless function at all: Vercel's Node runtime has no Python venv, so
the app's /api/cron/resolve route can't `spawn` the runner in production. It
POSTs here instead. The verdict machine is NOT re-implemented — this module is a
thin HTTP wrapper over persistence.resolve.resolve_due_predictions, the same
code path run_resolution.py (and the full pytest DB suite) exercise.

Guards, all enforced BEFORE any DB work:
  * SHARED-SECRET header (env CAUSENT_RESOLVE_SECRET) — constant-time compared;
    missing / wrong / server-unset all fail closed -> 401.
  * Small body cap (the payload is only {today?, scope_id?, user_id?}) -> 413.
  * Malformed body / bad date -> 400.

The DB connection mirrors run_resolution.py EXACTLY: connect as the DSN's login
role, then `SET ROLE authenticated` + a request.jwt.claims sub=<acting user> so
every read/write is RLS-scoped as that user — the service role is never the
acting identity. A prediction outside the acting user's scope is simply
invisible (SKIPPED_NOT_VISIBLE), never touched.

The module exposes:
  * handle_request(raw_body, provided_secret, *, sweep=...) -> (status, dict) —
    the pure, directly-unit-testable core. `sweep` is injected so the guards and
    serialization are tested with NO database (mirrors test_engine_function.py).
  * class handler(BaseHTTPRequestHandler) — the thin Vercel entrypoint.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
from collections import Counter
from datetime import date
from http.server import BaseHTTPRequestHandler
from uuid import UUID

# The engine package (persistence + causal) is bundled as a sibling via the
# deploy script's includeFiles. Put it on sys.path relative to THIS file so the
# import works both on Vercel and in local tests.
_ENGINE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "engine"))
if _ENGINE_DIR not in sys.path:
    sys.path.insert(0, _ENGINE_DIR)

from persistence.resolve import ResolutionResult, resolve_due_predictions  # noqa: E402

# --- Guard constants ---------------------------------------------------------

SECRET_HEADER = "x-causent-resolve-secret"
# The body is only {today?, scope_id?, user_id?}; anything larger is a caller
# error, rejected before we parse or connect.
MAX_BODY_BYTES = 10_000
# Cap the per-prediction rows echoed back so a huge sweep can't bloat the
# response; the counts summary is always complete.
MAX_RESULT_ROWS = 200

# Demo defaults (overridable per request or by env). The seeded demo owner IS
# the demo workspace's owner, so resolving AS this user under RLS sees the demo
# scope's due predictions. A real multi-tenant sweep passes scope_id + user_id.
_DEFAULT_SCOPE = os.environ.get("CAUSENT_RESOLVE_SCOPE", "ca5e0000-0000-0000-0000-0000000000d3")
_DEFAULT_USER = os.environ.get("CAUSENT_RESOLVE_USER", "ca5e1111-0000-0000-0000-0000000000d9")


class _BadRequest(Exception):
    """Malformed input -> 400."""


# --- Secret ------------------------------------------------------------------


def _secret_ok(provided: str | None) -> bool:
    """Constant-time shared-secret check. Fails closed: an unset server secret
    can never be matched, so the function refuses every request until it is
    configured (same contract as api/engine.py)."""
    expected = os.environ.get("CAUSENT_RESOLVE_SECRET", "")
    if not expected:
        return False
    return hmac.compare_digest(str(provided or ""), str(expected))


# --- Parsing -----------------------------------------------------------------


def _parse_body(raw_body: bytes) -> tuple[date | None, str, str]:
    """(raw_body) -> (today | None, scope_id, user_id). An empty body is valid:
    it means 'resolve today's due predictions for the default demo scope'."""
    if not raw_body:
        return None, _DEFAULT_SCOPE, _DEFAULT_USER
    try:
        payload = json.loads(raw_body)
    except (ValueError, TypeError) as exc:
        raise _BadRequest("invalid JSON body") from exc
    if not isinstance(payload, dict):
        raise _BadRequest("body must be a JSON object")

    today = None
    raw_today = payload.get("today")
    if raw_today is not None:
        if not isinstance(raw_today, str):
            raise _BadRequest("`today` must be an ISO date string 'YYYY-MM-DD'")
        try:
            today = date.fromisoformat(raw_today)
        except ValueError as exc:
            raise _BadRequest(f"`today` is not a valid ISO date: {raw_today!r}") from exc

    scope_id = _parse_uuid(payload.get("scope_id"), "scope_id", _DEFAULT_SCOPE)
    user_id = _parse_uuid(payload.get("user_id"), "user_id", _DEFAULT_USER)
    return today, scope_id, user_id


def _parse_uuid(raw: object, field: str, default: str) -> str:
    if raw is None:
        return default
    if not isinstance(raw, str):
        raise _BadRequest(f"`{field}` must be a UUID string")
    try:
        return str(UUID(raw))
    except ValueError as exc:
        raise _BadRequest(f"`{field}` is not a valid UUID: {raw!r}") from exc


# --- The real (DB-backed) sweep — the injectable default ---------------------


def _default_sweep(today: date, scope_id: str, user_id: str) -> list[ResolutionResult]:
    """Connect RLS-scoped AS `user_id` and resolve the scope's due predictions.

    Mirrors run_resolution.py's connection contract EXACTLY: autocommit off so
    each prediction's bridge materialization + verdict write lands in the resolve
    module's own commits, `SET ROLE authenticated` + request.jwt.claims sub so
    all I/O is scoped as the acting user (never the DSN's service/login role).
    psycopg is imported lazily so the pure guard tests never require a driver.
    """
    import psycopg  # local import: only the live path needs the driver

    dsn = os.environ.get(
        "DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    )
    conn = psycopg.connect(dsn)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        return resolve_due_predictions(conn, scope_id, today=today)
    finally:
        conn.close()


# --- Core --------------------------------------------------------------------


def handle_request(
    raw_body: bytes | str | None,
    provided_secret: str | None,
    *,
    sweep=_default_sweep,
    today_default=None,
) -> tuple[int, dict]:
    """Pure request handler: (raw_body, secret) -> (http_status, response_dict).

    Guard order is deliberate: auth, then size, then body validation, then the
    sweep. `sweep` and `today_default` are injected so tests exercise the full
    guard + serialization path with NO database. `today_default` supplies the
    server's "today" when the body omits it (the entrypoint passes date.today();
    tests pass a fixed date for determinism).
    """
    if not _secret_ok(provided_secret):
        return 401, {"error": "unauthorized"}

    if raw_body is None:
        raw_body = b""
    if isinstance(raw_body, str):
        raw_body = raw_body.encode("utf-8")
    if len(raw_body) > MAX_BODY_BYTES:
        return 413, {"error": f"request body exceeds {MAX_BODY_BYTES} bytes"}

    try:
        today, scope_id, user_id = _parse_body(raw_body)
    except _BadRequest as exc:
        return 400, {"error": str(exc)}
    if today is None:
        today = today_default or date.today()

    try:
        results = sweep(today, scope_id, user_id)
    except Exception as exc:  # pragma: no cover - genuine DB/driver fault only
        # A real connection/driver fault (not a caller error) -> 500 with a
        # short, non-sensitive detail so a curl of the cron tells the truth.
        return 500, {"error": "resolution sweep failed", "detail": type(exc).__name__}

    return 200, _summarize(results, scope_id, today)


def _summarize(results: list[ResolutionResult], scope_id: str, today: date) -> dict:
    processed = sum(1 for r in results if r.status in ("RESOLVED", "GATHERING"))
    by_verdict = Counter(r.verdict for r in results if r.verdict is not None)
    rows = [
        {
            "prediction_id": str(r.prediction_id),
            "status": r.status,
            "verdict": r.verdict,
            "detail": r.detail,
        }
        for r in results[:MAX_RESULT_ROWS]
    ]
    return {
        "ok": True,
        "scope_id": scope_id,
        "today": today.isoformat(),
        "processed": processed,
        "total": len(results),
        "by_verdict": dict(by_verdict),
        "results": rows,
        "truncated": len(results) > MAX_RESULT_ROWS,
    }


# --- Vercel Python entrypoint ------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel invokes this per request. POST only; everything else is 405."""

    def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            self._respond(413, {"error": f"request body exceeds {MAX_BODY_BYTES} bytes"})
            return
        raw = self.rfile.read(length) if length > 0 else b""
        secret = self.headers.get(SECRET_HEADER)
        status, body = handle_request(raw, secret)
        self._respond(status, body)

    def do_GET(self) -> None:  # noqa: N802
        self._respond(405, {"error": "method not allowed; POST JSON to this endpoint"})

    def _respond(self, status: int, obj: dict) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # silence default stderr access logging
        pass
