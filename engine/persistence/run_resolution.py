"""Resolution runner — resolve due predictions through the verdict machine.

Mirrors run_demo.py: connects RLS-scoped AS the demo owner (SET ROLE
authenticated + request.jwt.claims sub=<user>), never the service role, and
invokes persistence/resolve.py over the scope's due predictions. Cron
scheduling is Tranche 3 — this runner is the manual/dev path (and what the
UI's "Resolve now" affordance shells out to).

Run:
    cd engine && .venv/bin/python persistence/run_resolution.py
    # honors $DATABASE_URL; defaults to the local stack DSN.

Flags:
    --prediction <uuid>   resolve one prediction instead of the due sweep
    --today YYYY-MM-DD    override "today" (the seeded demo lives in the past)
    --force               resolve even if not yet due (single-prediction mode)
    --scope <uuid>        target scope       (default: the demo workspace)
    --user <uuid>         acting identity    (default: the demo owner)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import date

import psycopg

# Make the engine root importable whether invoked as
# `python persistence/run_resolution.py` or `python -m persistence.run_resolution`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from persistence.resolve import (  # noqa: E402
    resolve_due_predictions,
    resolve_prediction,
)
from persistence.seed_demo import DSN, ORG, SCOPE, USER  # noqa: E402


def _demo_owner(conn: psycopg.Connection) -> uuid.UUID:
    """The demo org's OWNER — the identity resolution runs as under RLS."""
    row = conn.execute(
        "select user_id from public.memberships where org_id = %s and role = 'owner' "
        "order by user_id limit 1",
        (ORG,),
    ).fetchone()
    return row[0] if row else USER


def _connect_as_user(user_id: uuid.UUID) -> psycopg.Connection:
    """A fresh RLS-scoped connection AS the user. autocommit=False so each
    prediction's resolution (bridge materialization + verdict write) lands in
    the resolve module's own commits — its production contract."""
    conn = psycopg.connect(DSN)
    conn.autocommit = False
    with conn.cursor() as cur:
        cur.execute("set role authenticated")
        claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
        cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
    return conn


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--scope", default=str(SCOPE))
    parser.add_argument("--user", default=None, help="acting user uuid (default: demo owner)")
    parser.add_argument("--prediction", default=None, help="resolve one prediction uuid")
    parser.add_argument("--today", default=None, help="YYYY-MM-DD override for 'today'")
    parser.add_argument("--force", action="store_true",
                        help="resolve even if not due (single-prediction mode)")
    args = parser.parse_args(argv)

    today = date.fromisoformat(args.today) if args.today else date.today()

    if args.user:
        acting_user = uuid.UUID(args.user)
    else:
        lookup = psycopg.connect(DSN)
        lookup.autocommit = True
        try:
            acting_user = _demo_owner(lookup)
        finally:
            lookup.close()

    conn = _connect_as_user(acting_user)
    try:
        if args.prediction:
            results = [
                resolve_prediction(conn, args.prediction, today=today, force=args.force)
            ]
        else:
            results = resolve_due_predictions(conn, args.scope, today=today)
    finally:
        conn.close()

    print(f"Resolution sweep — scope {args.scope}, today {today.isoformat()}, "
          f"acting as {acting_user}")
    print(f"  {'prediction':38s} {'status':26s} {'verdict':20s} detail")
    for r in results:
        print(f"  {str(r.prediction_id):38s} {r.status:26s} {r.verdict or '-':20s} {r.detail}")

    resolved = sum(1 for r in results if r.status in ("RESOLVED", "GATHERING"))
    print(f"\nRESULT: {resolved}/{len(results)} prediction(s) processed"
          + ("" if results else " (nothing due)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
