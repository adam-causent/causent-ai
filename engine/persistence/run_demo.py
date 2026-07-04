"""Phase A2 — run the persistence bridge over the ALREADY-seeded demo project.

`seed_demo.py` (Phase A1) stands up the demo tenant (org "Causent" -> project
"Orbit" -> workspace "Gummy Alpha": 5 metrics, 210 daily observations each, and
the shipped-PR actions). THIS runner is the Phase A2 step that materializes the
decision graph from that base data — it does NOT re-seed metrics/observations/
actions. For every metric in the demo workspace it invokes the real bridge:

    metric_observations + scope actions
          -> causal.batch_readout (ITS authoritative + BEFORE_AFTER_14D)
          -> UPSERT nodes / causal_edges  (belief projected from the ITS row)
          -> APPEND evidence_objects       (ITS + BEFORE_AFTER_14D)
          + cluster overlay

The bridge is run AS THE DEMO OWNER over an RLS-scoped connection (SET ROLE
authenticated + request.jwt.claims sub=<user>), never the service role — so RLS
is exercised exactly like production and the E2E gate.

Evidence is APPEND-ONLY, so to keep the demo graph byte-stable across re-runs
this runner first clears the DERIVED graph rows for the demo scope (nodes /
causal_edges / evidence_objects / clusters, and unsets actions.cluster_id) as the
superuser. The seeded base data (metrics / observations / actions) is untouched;
only the materialized output is rebuilt. Pass --append to skip the clear and
watch a fresh evidence set append on top (edges/nodes/clusters still converge).

Run:
    cd engine && .venv/bin/python persistence/run_demo.py
    # honors $DATABASE_URL; defaults to the local stack DSN.
"""

from __future__ import annotations

import json
import os
import sys
import uuid

import psycopg

# Make the engine root importable whether invoked as `python persistence/run_demo.py`
# or `python -m persistence.run_demo`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from persistence.bridge import persist_metric_readouts  # noqa: E402
from persistence.seed_demo import DSN, ORG, SCOPE, USER  # noqa: E402


def _demo_metrics(conn: psycopg.Connection) -> list[tuple[uuid.UUID, str]]:
    """Every metric in the demo workspace, in a stable order (mirrors seeding)."""
    return conn.execute(
        "select metric_id, name from public.metrics where scope_id = %s order by name",
        (SCOPE,),
    ).fetchall()


def _demo_owner(conn: psycopg.Connection) -> uuid.UUID:
    """The demo org's OWNER — the identity the bridge runs as under RLS."""
    row = conn.execute(
        "select user_id from public.memberships where org_id = %s and role = 'owner' "
        "order by user_id limit 1",
        (ORG,),
    ).fetchone()
    return row[0] if row else USER


def _clear_derived_graph(conn: psycopg.Connection) -> None:
    """Drop the DERIVED materialization for the demo scope (not the base data), so a
    re-run of the append-only bridge lands byte-stable counts. FK-safe order:
    evidence -> edges -> unset actions.cluster_id -> clusters -> nodes."""
    with conn.cursor() as cur:
        cur.execute("delete from public.evidence_objects where scope_id = %s", (SCOPE,))
        cur.execute("delete from public.causal_edges where scope_id = %s", (SCOPE,))
        cur.execute("update public.actions set cluster_id = null where scope_id = %s", (SCOPE,))
        cur.execute("delete from public.clusters where scope_id = %s", (SCOPE,))
        cur.execute("delete from public.nodes where scope_id = %s", (SCOPE,))


def _materialize_as_user(user_id: uuid.UUID, scope_id: uuid.UUID, metric_id: uuid.UUID) -> None:
    """Run the bridge over one metric on a fresh RLS-scoped connection AS the user.

    autocommit=False so the bridge's single terminal commit() lands the whole
    metric's materialization atomically — its production contract."""
    conn = psycopg.connect(DSN)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        persist_metric_readouts(conn, scope_id, metric_id)  # commits internally
    finally:
        conn.close()


def _verify(conn: psycopg.Connection) -> dict:
    cur = conn.cursor()

    def scalar(sql, params=()):
        cur.execute(sql, params)
        return cur.fetchone()[0]

    counts = {
        "nodes": scalar("select count(*) from public.nodes where scope_id=%s", (SCOPE,)),
        "causal_edges": scalar("select count(*) from public.causal_edges where scope_id=%s", (SCOPE,)),
        "clusters": scalar("select count(*) from public.clusters where scope_id=%s", (SCOPE,)),
        "evidence_objects": scalar(
            "select count(*) from public.evidence_objects where scope_id=%s", (SCOPE,)),
        "evidence_ITS": scalar(
            "select count(*) from public.evidence_objects "
            "where scope_id=%s and methodology='ITS'", (SCOPE,)),
        "evidence_BEFORE_AFTER_14D": scalar(
            "select count(*) from public.evidence_objects "
            "where scope_id=%s and methodology='BEFORE_AFTER_14D'", (SCOPE,)),
    }

    # Every edge must carry the authoritative ITS method (belief is the ITS projection).
    non_its = scalar(
        "select count(*) from public.causal_edges "
        "where scope_id=%s and authoritative_method <> 'ITS'", (SCOPE,))
    confident = scalar(
        "select count(*) from public.causal_edges "
        "where scope_id=%s and belief_score=1.0", (SCOPE,))
    insufficient = scalar(
        "select count(*) from public.causal_edges "
        "where scope_id=%s and belief_reason='INSUFFICIENT_HISTORY'", (SCOPE,))

    # Named ACTION -> METRIC readout for a human-readable table.
    cur.execute(
        "select a.external_ref, m.name, ce.direction, ce.belief_score, ce.belief_reason "
        "from public.causal_edges ce "
        "join public.nodes sn on sn.node_id=ce.source_node_id and sn.type='ACTION' "
        "join public.actions a on a.action_id=sn.semantic_ref "
        "join public.nodes tn on tn.node_id=ce.target_node_id and tn.type='METRIC' "
        "join public.metrics m on m.metric_id=tn.semantic_ref "
        "where ce.scope_id=%s "
        "order by a.effective_date, m.name", (SCOPE,))
    edges = cur.fetchall()

    return {"counts": counts, "non_its_edges": non_its, "confident_edges": confident,
            "insufficient_edges": insufficient, "edges": edges}


def main() -> int:
    append_mode = "--append" in sys.argv[1:]

    conn = psycopg.connect(DSN)
    conn.autocommit = True
    try:
        metrics = _demo_metrics(conn)
        if not metrics:
            print("No demo metrics found in scope", SCOPE,
                  "\nSeed the demo first: .venv/bin/python persistence/seed_demo.py")
            return 1
        owner = _demo_owner(conn)
        if not append_mode:
            _clear_derived_graph(conn)
    finally:
        conn.close()

    print(f"Materializing {len(metrics)} metrics for scope {SCOPE} as owner {owner}"
          f"{' (append mode)' if append_mode else ''}")
    for metric_id, name in metrics:
        _materialize_as_user(owner, SCOPE, metric_id)
        print(f"  bridged metric: {name}")

    conn = psycopg.connect(DSN)
    conn.autocommit = True
    try:
        result = _verify(conn)
    finally:
        conn.close()

    c = result["counts"]
    print("\n=== Materialized graph — row counts (scope: Causent/Orbit/Gummy Alpha) ===")
    for k, v in c.items():
        print(f"  {k:26s} {v}")
    print(f"\n  edges on authoritative ITS      : {c['causal_edges'] - result['non_its_edges']}"
          f"/{c['causal_edges']}")
    print(f"  confident edges (belief=1.0)    : {result['confident_edges']}")
    print(f"  INSUFFICIENT_HISTORY edges      : {result['insufficient_edges']}")

    print("\n=== ACTION -> METRIC edges (real engine readouts) ===")
    print(f"  {'action':9s} {'metric':16s} {'direction':13s} {'belief':7s} reason")
    for ref, metric, direction, belief, reason in result["edges"]:
        bstr = "-" if belief is None else f"{belief:.2f}"
        print(f"  {ref:9s} {metric:16s} {direction:13s} {bstr:7s} {reason or ''}")

    ok = (
        result["non_its_edges"] == 0
        and result["confident_edges"] >= 1
        and result["insufficient_edges"] >= 1
        and c["evidence_objects"] > 0
        and c["evidence_ITS"] == c["evidence_BEFORE_AFTER_14D"]
    )
    print("\nRESULT:", "PASS - authoritative-ITS edges, both confident and gathering-data paths present"
          if ok else "FAIL - required materialization invariants not met")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
