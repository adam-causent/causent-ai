"""Local tests for the resolution Vercel function (api/resolve.py).

These exercise the GUARDS + body parsing + response serialization through the
pure `handle_request` core with an INJECTED sweep — no database, no psycopg. A
missing/wrong/unset secret is 401; an over-cap body is 413; malformed JSON /
bad date / bad uuid are 400; a valid request calls the sweep with the parsed
(today, scope, user) and serializes the verdict counts. The DB-backed sweep
itself is the already-tested resolve_due_predictions (test_resolve_*.py); this
file proves the HTTP wrapper around it. We load the api module by path because
it lives outside the engine package (a Vercel serverless entry).
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
from datetime import date

import pytest

_API_FILE = pathlib.Path(__file__).resolve().parents[2] / "api" / "resolve.py"
_spec = importlib.util.spec_from_file_location("causent_resolve_api", _API_FILE)
api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api)

SECRET = "test-resolve-secret"
TODAY = date(2025, 5, 23)
SCOPE = "ca5e0000-0000-0000-0000-0000000000d3"
USER = "ca5e1111-0000-0000-0000-0000000000d9"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv("CAUSENT_RESOLVE_SECRET", SECRET)


class _Result:
    """Stand-in for persistence.resolve.ResolutionResult (only the read fields)."""

    def __init__(self, pid, status, verdict, detail=""):
        self.prediction_id = pid
        self.status = status
        self.verdict = verdict
        self.detail = detail


def _capturing_sweep(results):
    """A sweep that records its call args and returns canned results."""
    calls = {}

    def sweep(today, scope_id, user_id):
        calls["today"] = today
        calls["scope_id"] = scope_id
        calls["user_id"] = user_id
        return results

    return sweep, calls


def _call(body, secret=SECRET, sweep=None, today_default=TODAY):
    raw = None if body is None else json.dumps(body).encode()
    return api.handle_request(
        raw, secret, sweep=sweep or (lambda *_: []), today_default=today_default
    )


# --- secret guard ------------------------------------------------------------


def test_missing_secret_is_401():
    status, body = _call({}, secret=None)
    assert status == 401 and body["error"] == "unauthorized"


def test_wrong_secret_is_401():
    status, _ = _call({}, secret="nope")
    assert status == 401


def test_unset_server_secret_fails_closed(monkeypatch):
    monkeypatch.delenv("CAUSENT_RESOLVE_SECRET", raising=False)
    status, _ = _call({}, secret=SECRET)
    assert status == 401  # server secret unset -> nothing can match


# --- body caps + validation --------------------------------------------------


def test_oversized_body_is_413():
    raw = ("x" * (api.MAX_BODY_BYTES + 1)).encode()
    status, _ = api.handle_request(raw, SECRET, sweep=lambda *_: [])
    assert status == 413


def test_bad_json_is_400():
    status, _ = api.handle_request(b"{not json", SECRET, sweep=lambda *_: [])
    assert status == 400


def test_non_object_body_is_400():
    status, _ = api.handle_request(b"[1,2,3]", SECRET, sweep=lambda *_: [])
    assert status == 400


def test_bad_today_is_400():
    status, body = _call({"today": "2025-13-99"})
    assert status == 400 and "today" in body["error"]


def test_bad_uuid_is_400():
    status, body = _call({"scope_id": "not-a-uuid"})
    assert status == 400 and "scope_id" in body["error"]


# --- happy path + arg threading ---------------------------------------------


def test_empty_body_uses_defaults_and_today_default():
    sweep, calls = _capturing_sweep([])
    status, body = api.handle_request(None, SECRET, sweep=sweep, today_default=TODAY)
    assert status == 200
    assert calls["today"] == TODAY
    assert calls["scope_id"] == SCOPE
    assert calls["user_id"] == USER
    assert body["processed"] == 0 and body["total"] == 0


def test_overrides_thread_through_to_sweep():
    other_scope = "ca5e0000-0000-0000-0000-0000000000ff"
    sweep, calls = _capturing_sweep([])
    status, _ = api.handle_request(
        json.dumps({"today": "2025-06-01", "scope_id": other_scope}).encode(),
        SECRET,
        sweep=sweep,
    )
    assert status == 200
    assert calls["today"] == date(2025, 6, 1)
    assert calls["scope_id"] == other_scope
    assert calls["user_id"] == USER  # not overridden -> default


def test_summarizes_verdict_counts_and_processed():
    results = [
        _Result("p1", "RESOLVED", "CONFIRMED", "edge x"),
        _Result("p2", "RESOLVED", "REFUTED", "edge y"),
        _Result("p3", "GATHERING", "GATHERING", "extended"),
        _Result("p4", "SKIPPED_NOT_DUE", None, "due later"),
    ]
    sweep, _ = _capturing_sweep(results)
    status, body = api.handle_request(b"{}", SECRET, sweep=sweep, today_default=TODAY)
    assert status == 200
    assert body["total"] == 4
    assert body["processed"] == 3  # RESOLVED + GATHERING, not SKIPPED
    assert body["by_verdict"] == {"CONFIRMED": 1, "REFUTED": 1, "GATHERING": 1}
    assert body["results"][0] == {
        "prediction_id": "p1",
        "status": "RESOLVED",
        "verdict": "CONFIRMED",
        "detail": "edge x",
    }
    assert body["truncated"] is False


def test_result_rows_capped_but_counts_complete():
    results = [_Result(f"p{i}", "RESOLVED", "CONFIRMED") for i in range(api.MAX_RESULT_ROWS + 5)]
    sweep, _ = _capturing_sweep(results)
    status, body = api.handle_request(b"{}", SECRET, sweep=sweep, today_default=TODAY)
    assert status == 200
    assert body["total"] == api.MAX_RESULT_ROWS + 5
    assert len(body["results"]) == api.MAX_RESULT_ROWS
    assert body["truncated"] is True
    assert body["by_verdict"]["CONFIRMED"] == api.MAX_RESULT_ROWS + 5


def test_sweep_exception_is_500_without_leaking():
    def boom(*_):
        raise RuntimeError("secret connection string leaked here")

    status, body = api.handle_request(b"{}", SECRET, sweep=boom, today_default=TODAY)
    assert status == 500
    assert body["error"] == "resolution sweep failed"
    assert body["detail"] == "RuntimeError"  # type name only, no message
