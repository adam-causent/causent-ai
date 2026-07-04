"""Deploy-ready Vercel Python function wrapping the causal engine's batch_readout.

This is the ONLY network-facing entry to the causal engine. It is STATELESS and
holds NO database credentials: the Next.js app is the sole DB owner and passes the
already-RLS-scoped daily series to this function as plain data. The function turns
{series, action_dates, methods} into one row per (action x method):

    ITS              -> the authoritative Interrupted Time Series readout + belief
    BEFORE_AFTER_14D -> the descriptive 14-day mean-diff cross-check

Guards (per the eng review), all enforced BEFORE any compute:
  * SHARED-SECRET header (env CAUSENT_ENGINE_SECRET) — constant-time compared;
    missing / wrong / server-unset all fail closed -> 401.
  * HARD input caps: raw body bytes, series length (<= MAX_SERIES_POINTS ~10y daily),
    action count (<= MAX_ACTIONS) -> 413 over any cap. This bounds compute + memory,
    so it doubles as the size/timeout guard (the numpy work is O(points x actions)
    and both factors are capped; maxDuration in vercel.json is the belt-and-braces).
  * Degenerate / flat / collinear / insufficient data NEVER 500s and NEVER fabricates
    a confidence interval: the engine returns a defined "inconclusive" row (status
    DEGENERATE / INSUFFICIENT / INSUFFICIENT_HISTORY, lift + CI null, belief withheld).
    Only a genuine unexpected bug reaches the generic 500 path.

The module exposes two things:
  * handle_request(raw_body, provided_secret) -> (status_int, dict) — the pure,
    directly-unit-testable core (no sockets).
  * class handler(BaseHTTPRequestHandler) — the thin Vercel Python entrypoint that
    reads the request and delegates to handle_request.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
from bisect import bisect_left
from datetime import date
from http.server import BaseHTTPRequestHandler
from math import isfinite

# The engine is a sibling package bundled via vercel.json `includeFiles`. Put it on
# sys.path relative to THIS file so the import works both on Vercel and in local tests.
_ENGINE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "engine"))
if _ENGINE_DIR not in sys.path:
    sys.path.insert(0, _ENGINE_DIR)

import numpy as np  # noqa: E402  (after sys.path fix-up)

from causal.batch_readout import batch_readout  # noqa: E402
from causal.types import Series  # noqa: E402

# --- Guard constants ---------------------------------------------------------

SECRET_HEADER = "x-causent-engine-secret"
# ~10 years of daily observations. Caps both memory and the O(points) fit cost.
MAX_SERIES_POINTS = 3650
# Matches batch_readout's own fan-out cap; a metric colliding with more actions is a
# caller error, not something to silently compute.
MAX_ACTIONS = 200
# A comfortable ceiling for a capped payload (3650 dated points + 200 actions is well
# under this); anything larger is rejected before we allocate or parse it.
MAX_BODY_BYTES = 2_000_000
# The methods this function will serialize a row for. ITS is authoritative; the
# 14-day before/after is descriptive.
ALLOWED_METHODS = ("ITS", "BEFORE_AFTER_14D")


class _BadRequest(Exception):
    """Malformed input -> 400."""


class _CapError(Exception):
    """A hard input cap was exceeded -> 413."""


# --- Secret ------------------------------------------------------------------


def _secret_ok(provided: str | None) -> bool:
    """Constant-time shared-secret check. Fails closed: an unset server secret can
    never be matched, so the function refuses every request until it is configured."""
    expected = os.environ.get("CAUSENT_ENGINE_SECRET", "")
    if not expected:
        return False
    return hmac.compare_digest(str(provided or ""), str(expected))


# --- Parsing / validation ----------------------------------------------------


def _num(x: float | None) -> float | None:
    """JSON-safe float: None and non-finite (NaN/Inf) collapse to null so we never
    emit invalid JSON or a fabricated numeric where the engine reported no value."""
    if x is None:
        return None
    xf = float(x)
    return xf if isfinite(xf) else None


def _parse_series(series_in: object) -> tuple[list[int], np.ndarray]:
    """Validate the daily series and return (ordinal_dates, float64_values).

    Each point is {"date": "YYYY-MM-DD", "value": <number|null>} or a
    [date, value] pair. Dates must be strictly ascending (sorted + unique), matching
    the engine's Series contract. A null value becomes NaN (the engine's degeneracy
    guards handle it). The length cap is checked BEFORE per-point parsing so an
    oversized payload is rejected cheaply.
    """
    if not isinstance(series_in, list):
        raise _BadRequest("`series` must be a list of {date, value} points")
    if len(series_in) == 0:
        raise _BadRequest("`series` must be non-empty")
    if len(series_in) > MAX_SERIES_POINTS:
        raise _CapError(
            f"series has {len(series_in)} points; max is {MAX_SERIES_POINTS}"
        )

    ordinals: list[int] = []
    values: list[float] = []
    for i, pt in enumerate(series_in):
        if isinstance(pt, dict):
            d_raw, v_raw = pt.get("date"), pt.get("value")
        elif isinstance(pt, (list, tuple)) and len(pt) == 2:
            d_raw, v_raw = pt[0], pt[1]
        else:
            raise _BadRequest(f"series[{i}] must be a {{date, value}} object or pair")
        ordinals.append(_parse_date(d_raw, f"series[{i}].date"))
        values.append(_parse_value(v_raw, f"series[{i}].value"))

    for i in range(1, len(ordinals)):
        if ordinals[i] <= ordinals[i - 1]:
            raise _BadRequest("series dates must be strictly ascending (sorted, unique)")

    return ordinals, np.array(values, dtype=np.float64)


def _parse_date(raw: object, field: str) -> int:
    if not isinstance(raw, str):
        raise _BadRequest(f"{field} must be an ISO date string 'YYYY-MM-DD'")
    try:
        return date.fromisoformat(raw).toordinal()
    except ValueError as exc:
        raise _BadRequest(f"{field} is not a valid ISO date: {raw!r}") from exc


def _parse_value(raw: object, field: str) -> float:
    if raw is None:
        return float("nan")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise _BadRequest(f"{field} must be a number or null")
    return float(raw)


def _parse_actions(action_dates: object, ordinals: list[int]) -> list[tuple[str, int]]:
    """Map each action's effective date to its intervention split via bisect_left
    (first observation on/after the date is the first post point) — the same rule the
    persistence bridge uses. Returns (action_ref, split) pairs in input order; the
    ref is the ISO date the caller supplied. The count cap is checked before parsing."""
    if action_dates is None:
        return []
    if not isinstance(action_dates, list):
        raise _BadRequest("`action_dates` must be a list of ISO date strings")
    if len(action_dates) > MAX_ACTIONS:
        raise _CapError(
            f"{len(action_dates)} actions exceeds max of {MAX_ACTIONS}"
        )
    splits: list[tuple[str, int]] = []
    for i, raw in enumerate(action_dates):
        ordinal = _parse_date(raw, f"action_dates[{i}]")
        splits.append((str(raw), bisect_left(ordinals, ordinal)))
    return splits


def _parse_methods(methods_in: object) -> list[str]:
    if methods_in is None:
        return list(ALLOWED_METHODS)
    if not isinstance(methods_in, list) or not methods_in:
        raise _BadRequest("`methods` must be a non-empty list")
    out: list[str] = []
    for m in methods_in:
        if m not in ALLOWED_METHODS:
            raise _BadRequest(
                f"unknown method {m!r}; allowed: {list(ALLOWED_METHODS)}"
            )
        if m not in out:
            out.append(m)
    return out


# --- Row serialization -------------------------------------------------------


def _its_row(ref: str, readout) -> dict:
    its, belief = readout.its, readout.belief
    # "inconclusive" is the honest surface for every non-OK / straddling-zero verdict:
    # no lift, no CI, belief withheld. We never invent a CI where the engine has none.
    inconclusive = its.status != "OK" or its.direction == "INCONCLUSIVE"
    return {
        "action_ref": ref,
        "method": "ITS",
        "status": its.status,
        "direction": its.direction,
        "inconclusive": inconclusive,
        "lift": _num(its.lift),
        "ci_low": _num(its.ci_low),
        "ci_high": _num(its.ci_high),
        "p_value": _num(its.p_value),
        "durbin_watson": _num(its.durbin_watson),
        "n_pre": its.n_pre,
        "n_post": its.n_post,
        "belief_score": belief.belief_score,
        "belief_direction": belief.direction,
        "belief_reason": belief.reason,
    }


def _before_after_row(ref: str, readout) -> dict:
    ba = readout.before_after
    return {
        "action_ref": ref,
        "method": "BEFORE_AFTER_14D",
        "status": ba.status,
        "inconclusive": ba.lift is None,
        "lift": _num(ba.lift),
        "ci_low": _num(ba.ci_low),
        "ci_high": _num(ba.ci_high),
    }


_ROW_BUILDERS = {"ITS": _its_row, "BEFORE_AFTER_14D": _before_after_row}


# --- Core --------------------------------------------------------------------


def handle_request(raw_body: bytes | str | None, provided_secret: str | None) -> tuple[int, dict]:
    """Pure request handler: (raw_body, secret) -> (http_status, response_dict).

    No sockets, no globals beyond env — directly unit-testable. Guard order is
    deliberate: auth, then size, then structural validation + caps, then compute.
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
        payload = json.loads(raw_body or b"{}")
    except (ValueError, TypeError):
        return 400, {"error": "invalid JSON body"}
    if not isinstance(payload, dict):
        return 400, {"error": "body must be a JSON object"}

    try:
        ordinals, values = _parse_series(payload.get("series"))
        action_splits = _parse_actions(payload.get("action_dates"), ordinals)
        methods = _parse_methods(payload.get("methods"))
    except _CapError as exc:
        return 413, {"error": str(exc)}
    except _BadRequest as exc:
        return 400, {"error": str(exc)}

    try:
        rows = _run(ordinals, values, action_splits, methods)
    except Exception:  # pragma: no cover - genuine unexpected bug only
        # Degenerate/flat/collinear data does NOT reach here (the engine returns a
        # defined inconclusive row for it); only an unforeseen fault would.
        return 500, {"error": "engine failure"}

    return 200, {"rows": rows, "n_actions": len(action_splits), "methods": methods}


def _run(ordinals, values, action_splits, methods) -> list[dict]:
    # split=0 is a placeholder; batch_readout builds a per-action view from each
    # action's own split, so the Series-level split is never read.
    series = Series(np.array(ordinals, dtype=np.int64), values, 0)
    readouts = batch_readout(series, action_splits, max_actions=MAX_ACTIONS)
    rows: list[dict] = []
    for readout in readouts:
        for method in methods:
            rows.append(_ROW_BUILDERS[method](readout.action_ref, readout))
    return rows


# --- Vercel Python entrypoint ------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel invokes this per request. POST only; everything else is 405."""

    def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            # Reject oversized uploads without buffering the whole body.
            self._respond(413, {"error": f"request body exceeds {MAX_BODY_BYTES} bytes"})
            return
        raw = self.rfile.read(length) if length > 0 else b""
        secret = self.headers.get(SECRET_HEADER)
        status, body = handle_request(raw, secret)
        self._respond(status, body)

    def do_GET(self) -> None:  # noqa: N802
        self._respond(405, {"error": "method not allowed; POST JSON to this endpoint"})

    def _respond(self, status: int, obj: dict) -> None:
        data = json.dumps(obj, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # silence default stderr access logging
        pass
