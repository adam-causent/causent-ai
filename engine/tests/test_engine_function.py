"""Local tests for the deploy-ready Vercel Python function (api/engine.py).

These exercise the GUARDS and the happy path through the pure `handle_request`
core (no sockets): a valid batch recovers a planted step; a missing/wrong secret is
401; over-cap series/actions/body are 413; degenerate/flat data returns a defined
"inconclusive" row, never a 500 and never a fabricated CI. We load the api module by
path because it lives outside the engine package (it is a Vercel serverless entry).
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
from datetime import date, timedelta

import pytest

# api/engine.py sits at <repo>/api/engine.py; this test is <repo>/engine/tests/...
_API_FILE = pathlib.Path(__file__).resolve().parents[2] / "api" / "engine.py"
_spec = importlib.util.spec_from_file_location("causent_engine_api", _API_FILE)
api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api)

SECRET = "test-secret-value"
_BASE = date(2025, 1, 1)


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv("CAUSENT_ENGINE_SECRET", SECRET)


def _iso(i: int) -> str:
    return (_BASE + timedelta(days=i)).isoformat()


def _stepped_series(n_pre: int, n_post: int, step: float, slope: float = 0.3, level: float = 5.0):
    """A clean daily series with a KNOWN level shift of `step` at index n_pre."""
    n = n_pre + n_post
    series = []
    for i in range(n):
        value = level + slope * i + (step if i >= n_pre else 0.0)
        series.append({"date": _iso(i), "value": value})
    return series


def _post(payload: dict, secret: str | None = SECRET):
    return api.handle_request(json.dumps(payload).encode(), secret)


# --- valid batch -------------------------------------------------------------


def test_valid_batch_recovers_planted_step():
    # 50 pre + 50 post (both >= FLOOR_CONFIDENT=45) with a clean +8 step at day 50.
    series = _stepped_series(50, 50, 8.0)
    status, body = _post({"series": series, "action_dates": [_iso(50)]})

    assert status == 200
    assert body["n_actions"] == 1
    assert body["methods"] == ["ITS", "BEFORE_AFTER_14D"]

    its = next(r for r in body["rows"] if r["method"] == "ITS")
    assert its["action_ref"] == _iso(50)
    assert its["status"] == "OK"
    assert its["direction"] == "POSITIVE"
    assert its["inconclusive"] is False
    assert its["lift"] == pytest.approx(8.0, abs=1e-6)
    assert its["ci_low"] is not None and its["ci_high"] is not None
    assert its["belief_score"] == 1.0
    assert its["belief_direction"] == "POSITIVE"

    ba = next(r for r in body["rows"] if r["method"] == "BEFORE_AFTER_14D")
    assert ba["action_ref"] == _iso(50)
    assert ba["status"] == "OK"

    # Response is strict JSON (no NaN/Inf leaking through).
    json.dumps(body, allow_nan=False)


def test_methods_filter_limits_returned_rows():
    series = _stepped_series(50, 50, 8.0)
    status, body = _post({"series": series, "action_dates": [_iso(50)], "methods": ["ITS"]})
    assert status == 200
    assert {r["method"] for r in body["rows"]} == {"ITS"}


def test_multiple_actions_return_row_per_action_per_method():
    series = _stepped_series(50, 50, 8.0)
    status, body = _post({"series": series, "action_dates": [_iso(30), _iso(50)]})
    assert status == 200
    assert len(body["rows"]) == 4  # 2 actions x 2 methods
    assert [r["action_ref"] for r in body["rows"] if r["method"] == "ITS"] == [_iso(30), _iso(50)]


# --- secret guard (401) ------------------------------------------------------


def test_missing_secret_is_401():
    series = _stepped_series(50, 50, 8.0)
    status, body = _post({"series": series, "action_dates": [_iso(50)]}, secret=None)
    assert status == 401 and body["error"] == "unauthorized"


def test_wrong_secret_is_401():
    series = _stepped_series(50, 50, 8.0)
    status, body = _post({"series": series, "action_dates": [_iso(50)]}, secret="nope")
    assert status == 401


def test_unset_server_secret_fails_closed(monkeypatch):
    monkeypatch.delenv("CAUSENT_ENGINE_SECRET", raising=False)
    status, _ = _post({"series": _stepped_series(50, 50, 8.0)}, secret="anything")
    assert status == 401


# --- input caps (413) --------------------------------------------------------


def test_series_over_cap_is_413():
    oversized = [{"date": _iso(i), "value": 1.0} for i in range(api.MAX_SERIES_POINTS + 1)]
    status, body = _post({"series": oversized, "action_dates": []})
    assert status == 413 and "max" in body["error"]


def test_action_count_over_cap_is_413():
    series = _stepped_series(50, 50, 8.0)
    too_many = [_iso(50)] * (api.MAX_ACTIONS + 1)
    status, body = _post({"series": series, "action_dates": too_many})
    assert status == 413


def test_body_over_cap_is_413():
    big = b"x" * (api.MAX_BODY_BYTES + 1)
    status, body = api.handle_request(big, SECRET)
    assert status == 413


# --- degenerate data -> inconclusive, never 500 ------------------------------


def test_flat_series_is_inconclusive_not_500():
    # A perfectly flat metric has no variance -> the fit is DEGENERATE. Must be a
    # defined 200 row with belief withheld and NO fabricated CI, never a 500.
    flat = [{"date": _iso(i), "value": 7.0} for i in range(60)]
    status, body = _post({"series": flat, "action_dates": [_iso(30)]})
    assert status == 200

    its = next(r for r in body["rows"] if r["method"] == "ITS")
    assert its["status"] == "DEGENERATE"
    assert its["inconclusive"] is True
    assert its["direction"] == "INCONCLUSIVE"
    assert its["lift"] is None and its["ci_low"] is None and its["ci_high"] is None
    assert its["belief_score"] is None


def test_below_floor_history_is_inconclusive():
    # Fittable but < FLOOR_CONFIDENT per side: honest INSUFFICIENT_HISTORY, no belief.
    series = _stepped_series(20, 20, 4.0, slope=0.0)
    status, body = _post({"series": series, "action_dates": [_iso(20)]})
    assert status == 200
    its = next(r for r in body["rows"] if r["method"] == "ITS")
    assert its["status"] == "INSUFFICIENT_HISTORY"
    assert its["inconclusive"] is True
    assert its["belief_score"] is None
    # The always-on descriptive cross-check still yields a real number below the floor.
    ba = next(r for r in body["rows"] if r["method"] == "BEFORE_AFTER_14D")
    assert ba["lift"] is not None


def test_action_outside_series_range_is_defined_not_500():
    series = _stepped_series(50, 50, 8.0)
    status, body = _post({"series": series, "action_dates": [_iso(1000)]})
    assert status == 200
    its = next(r for r in body["rows"] if r["method"] == "ITS")
    assert its["status"] == "INSUFFICIENT"  # split past the end -> n_post < 14


# --- malformed input (400) ---------------------------------------------------


def test_invalid_json_is_400():
    status, body = api.handle_request(b"{not json", SECRET)
    assert status == 400 and body["error"] == "invalid JSON body"


def test_non_object_body_is_400():
    status, _ = api.handle_request(b"[1, 2, 3]", SECRET)
    assert status == 400


def test_unknown_method_is_400():
    series = _stepped_series(50, 50, 8.0)
    status, body = _post({"series": series, "action_dates": [_iso(50)], "methods": ["MAGIC"]})
    assert status == 400 and "unknown method" in body["error"]


def test_empty_series_is_400():
    status, _ = _post({"series": [], "action_dates": []})
    assert status == 400


def test_unsorted_dates_is_400():
    series = [{"date": _iso(2), "value": 1.0}, {"date": _iso(1), "value": 2.0}]
    status, body = _post({"series": series})
    assert status == 400 and "ascending" in body["error"]


def test_non_numeric_value_is_400():
    series = [{"date": _iso(0), "value": "high"}, {"date": _iso(1), "value": 2.0}]
    status, _ = _post({"series": series})
    assert status == 400


def test_null_value_is_accepted_as_nan():
    # Null observations are allowed (become NaN); a sparse series must not 400 or 500.
    series = _stepped_series(50, 50, 8.0)
    series[10]["value"] = None
    status, body = _post({"series": series, "action_dates": [_iso(50)]})
    assert status == 200


# --- entrypoint wiring -------------------------------------------------------


def test_module_exposes_vercel_handler():
    from http.server import BaseHTTPRequestHandler

    assert issubclass(api.handler, BaseHTTPRequestHandler)
    assert hasattr(api.handler, "do_POST")
