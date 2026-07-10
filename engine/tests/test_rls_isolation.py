"""Live RLS tenant-isolation gate for Causent's Postgres schema.

Runs against the local Supabase Postgres. As the (bypassrls) postgres role we SEED
two fully-populated tenants (orgs A and B, a user in each, org-level memberships,
and one row in EVERY domain table under each org's workspace). Then, on fresh
connections, we act AS each user by:

    SET ROLE authenticated;
    SELECT set_config('request.jwt.claims',
        json_build_object('sub', <user-uuid>, 'role', 'authenticated')::text, false);

`authenticated` is not a superuser and does not bypass RLS, so every policy in
supabase/migrations/*_v1_rls.sql is actually enforced for these connections.

The gate (see the assert_* tests): cross-tenant isolation, RLS-enabled-everywhere,
role checks (viewer blocked / member allowed / cross-org blocked), org->workspace
inheritance, and evidence append-only (no UPDATE/DELETE for authenticated).

Nothing here weakens an assertion to make the suite pass; a real leak fails the gate.
"""

from __future__ import annotations

import contextlib
import json
import uuid

import psycopg
import pytest
from psycopg import errors as pgerr

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# --- Deterministic seed UUIDs (namespaced so teardown is exact) ---------------
ORG_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a0")
ORG_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000b0")
PROJ_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a1")
PROJ_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000b1")
WS_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a2")
WS_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000b2")

USER_A = uuid.UUID("aaaa1111-0000-0000-0000-0000000000a9")  # member of org A
USER_B = uuid.UUID("bbbb1111-0000-0000-0000-0000000000b9")  # member of org B
USER_A_VIEWER = uuid.UUID("aaaa2222-0000-0000-0000-0000000000a8")  # viewer in org A

# Per-org domain row ids
METRIC_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c0")
METRIC_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d0")
CLUSTER_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c1")
CLUSTER_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d1")
ACTION_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c2")
ACTION_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d2")
NODE_A_SRC = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c3")
NODE_A_TGT = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c4")
NODE_B_SRC = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d3")
NODE_B_TGT = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d4")
EDGE_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c5")
EDGE_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d5")
EVIDENCE_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c6")
EVIDENCE_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d6")
OBJECTIVE_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000c7")
OBJECTIVE_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000d7")

ALL_USERS = (USER_A, USER_B, USER_A_VIEWER)

# Domain tables under a workspace + how to identify a row's tenant.
# (table, id_expr, A-value, B-value). id_expr resolves the tenant per row.
DOMAIN_TABLES = [
    ("public.metrics", "scope_id", WS_A, WS_B),
    ("public.metric_observations", "metric_id", METRIC_A, METRIC_B),
    ("public.clusters", "scope_id", WS_A, WS_B),
    ("public.actions", "scope_id", WS_A, WS_B),
    ("public.nodes", "scope_id", WS_A, WS_B),
    ("public.causal_edges", "scope_id", WS_A, WS_B),
    ("public.evidence_objects", "scope_id", WS_A, WS_B),
    ("public.objectives", "scope_id", WS_A, WS_B),
]

# Hierarchy / spine tables also carry tenant identity and must isolate too.
HIERARCHY_TABLES = [
    ("public.orgs", "org_id", ORG_A, ORG_B),
    ("public.projects", "project_id", PROJ_A, PROJ_B),
    ("public.workspaces", "workspace_id", WS_A, WS_B),
    ("public.memberships", "org_id", ORG_A, ORG_B),
]

ISOLATION_TABLES = DOMAIN_TABLES + HIERARCHY_TABLES


# --- Connection helpers -------------------------------------------------------
def _superuser_conn() -> psycopg.Connection:
    conn = psycopg.connect(DSN)
    conn.autocommit = True
    return conn


@contextlib.contextmanager
def as_user(user_id: uuid.UUID, autocommit: bool = True):
    """Fresh connection acting AS `user_id` under RLS (role=authenticated)."""
    conn = psycopg.connect(DSN)
    conn.autocommit = autocommit
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        yield conn
    finally:
        conn.close()


# --- Seed / teardown ----------------------------------------------------------
def _teardown(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        # orgs cascade to projects/workspaces/memberships and all scoped domain rows.
        cur.execute("delete from public.orgs where org_id = any(%s)", ([ORG_A, ORG_B],))
        cur.execute(
            "delete from auth.users where id = any(%s)", (list(ALL_USERS),)
        )


def _seed(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        # auth.users (only id is required NOT NULL / no default)
        for uid in ALL_USERS:
            cur.execute("insert into auth.users (id) values (%s)", (uid,))

        # scope hierarchy
        cur.execute("insert into public.orgs (org_id, name) values (%s,%s),(%s,%s)",
                    (ORG_A, "RLS_TEST_org_A", ORG_B, "RLS_TEST_org_B"))
        cur.execute(
            "insert into public.projects (project_id, org_id, name) values (%s,%s,%s),(%s,%s,%s)",
            (PROJ_A, ORG_A, "RLS_TEST_proj_A", PROJ_B, ORG_B, "RLS_TEST_proj_B"),
        )
        cur.execute(
            "insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,%s),(%s,%s,%s)",
            (WS_A, PROJ_A, "RLS_TEST_ws_A", WS_B, PROJ_B, "RLS_TEST_ws_B"),
        )

        # memberships: org-level grants (project_id/workspace_id NULL => inherit down)
        cur.execute(
            "insert into public.memberships (user_id, org_id, role) values "
            "(%s,%s,'member'),(%s,%s,'member'),(%s,%s,'viewer')",
            (USER_A, ORG_A, USER_B, ORG_B, USER_A_VIEWER, ORG_A),
        )

        # one row in every domain table, per org, under that org's workspace
        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source) values "
            "(%s,%s,'m','csv'),(%s,%s,'m','csv')",
            (METRIC_A, WS_A, METRIC_B, WS_B),
        )
        cur.execute(
            "insert into public.metric_observations (metric_id, obs_date, value) values "
            "(%s, date '2026-01-01', 1),(%s, date '2026-01-01', 2)",
            (METRIC_A, METRIC_B),
        )
        cur.execute(
            "insert into public.clusters (cluster_id, scope_id, metric_id, window_start, window_end) values "
            "(%s,%s,%s, date '2026-01-01', date '2026-01-31'),"
            "(%s,%s,%s, date '2026-01-01', date '2026-01-31')",
            (CLUSTER_A, WS_A, METRIC_A, CLUSTER_B, WS_B, METRIC_B),
        )
        cur.execute(
            "insert into public.actions (action_id, scope_id, source) values "
            "(%s,%s,'manual'),(%s,%s,'manual')",
            (ACTION_A, WS_A, ACTION_B, WS_B),
        )
        cur.execute(
            "insert into public.nodes (node_id, scope_id, type, semantic_ref) values "
            "(%s,%s,'ACTION',%s),(%s,%s,'METRIC',%s),(%s,%s,'ACTION',%s),(%s,%s,'METRIC',%s)",
            (NODE_A_SRC, WS_A, ACTION_A, NODE_A_TGT, WS_A, METRIC_A,
             NODE_B_SRC, WS_B, ACTION_B, NODE_B_TGT, WS_B, METRIC_B),
        )
        cur.execute(
            "insert into public.causal_edges (edge_id, scope_id, source_node_id, target_node_id, direction) values "
            "(%s,%s,%s,%s,'POSITIVE'),(%s,%s,%s,%s,'POSITIVE')",
            (EDGE_A, WS_A, NODE_A_SRC, NODE_A_TGT, EDGE_B, WS_B, NODE_B_SRC, NODE_B_TGT),
        )
        cur.execute(
            "insert into public.evidence_objects (evidence_id, scope_id, edge_id, methodology) values "
            "(%s,%s,%s,'ITS'),(%s,%s,%s,'ITS')",
            (EVIDENCE_A, WS_A, EDGE_A, EVIDENCE_B, WS_B, EDGE_B),
        )
        cur.execute(
            "insert into public.objectives (objective_id, scope_id, statement) values "
            "(%s,%s,'o'),(%s,%s,'o')",
            (OBJECTIVE_A, WS_A, OBJECTIVE_B, WS_B),
        )


@pytest.fixture(scope="module")
def seeded():
    conn = _superuser_conn()
    _teardown(conn)  # clean any residue from a prior aborted run
    _seed(conn)
    try:
        yield conn
    finally:
        _teardown(conn)
        conn.close()


# ============================================================================
# GATE 1 — Cross-tenant isolation: as A see A's rows, ZERO of B's (and reverse)
# ============================================================================
def test_cross_tenant_isolation_no_leaks(seeded):
    leaks: list[str] = []
    # (viewer, own_id, foreign_id) per user under test
    perspectives = [
        (USER_A, WS_A, WS_B, ORG_A, ORG_B, PROJ_A, PROJ_B, METRIC_A, METRIC_B),
        (USER_B, WS_B, WS_A, ORG_B, ORG_A, PROJ_B, PROJ_A, METRIC_B, METRIC_A),
    ]
    for pov in perspectives:
        user = pov[0]
        with as_user(user) as conn, conn.cursor() as cur:
            for table, id_expr, a_val, b_val in ISOLATION_TABLES:
                # map A/B identifiers to this user's own vs foreign
                if user == USER_A:
                    own, foreign = a_val, b_val
                else:
                    own, foreign = b_val, a_val
                # foreign rows visible == LEAK
                cur.execute(
                    f"select count(*) from {table} where {id_expr} = %s", (foreign,)
                )
                foreign_visible = cur.fetchone()[0]
                if foreign_visible != 0:
                    leaks.append(
                        f"user {user} sees {foreign_visible} foreign row(s) in "
                        f"{table} (where {id_expr}={foreign})"
                    )
                # own row must be visible (proves the query can see anything at all)
                cur.execute(
                    f"select count(*) from {table} where {id_expr} = %s", (own,)
                )
                own_visible = cur.fetchone()[0]
                if own_visible < 1:
                    leaks.append(
                        f"user {user} sees 0 OWN rows in {table} "
                        f"(where {id_expr}={own}) — RLS over-blocks, seed/policy broken"
                    )
    assert leaks == [], "CROSS-TENANT LEAKS:\n" + "\n".join(leaks)


# ============================================================================
# GATE 2 — RLS enabled on every public table created by the migrations
# ============================================================================
def test_rls_enabled_on_every_public_table(seeded):
    with seeded.cursor() as cur:
        cur.execute(
            """
            select c.relname, c.relrowsecurity
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
            order by c.relname
            """
        )
        rows = cur.fetchall()
    rls_off = [name for name, on in rows if not on]
    assert rls_off == [], f"RLS DISABLED on public tables: {rls_off}"
    # sanity: we actually inspected the 11 migration tables
    assert len(rows) >= 11, f"expected >=11 public tables, saw {len(rows)}"


# ============================================================================
# GATE 3 — Role checks: viewer blocked, member allowed, cross-org blocked
# ============================================================================
def test_viewer_cannot_insert(seeded):
    # viewer role (rank 1) < member (rank 2) required by metrics_insert WITH CHECK
    with as_user(USER_A_VIEWER, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.metrics (scope_id, name, source) values (%s,'blocked','csv')",
                (WS_A,),
            )
        conn.rollback()


def test_member_can_insert_own_scope(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "insert into public.metrics (scope_id, name, source) values (%s,'ok','csv')",
            (WS_A,),
        )
        assert cur.rowcount == 1
        conn.rollback()  # keep the seed pristine


def test_member_cannot_insert_foreign_scope(seeded):
    # user A (member of org A) writing into org B's workspace must be blocked
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.metrics (scope_id, name, source) values (%s,'leak','csv')",
                (WS_B,),
            )
        conn.rollback()


# ============================================================================
# GATE 4 — Inheritance: an ORG-level membership reads a WORKSPACE-scoped row
# ============================================================================
def test_org_grant_inherits_to_workspace_row(seeded):
    # USER_A's membership has project_id/workspace_id NULL (org-wide). It must
    # still resolve read access to a row living in a workspace under that org.
    with as_user(USER_A) as conn, conn.cursor() as cur:
        cur.execute(
            "select count(*) from public.metrics where metric_id = %s", (METRIC_A,)
        )
        assert cur.fetchone()[0] == 1


# ============================================================================
# GATE 5 — Append-only: authenticated cannot UPDATE or DELETE evidence_objects
# ============================================================================
def test_evidence_is_append_only(seeded):
    # UPDATE/DELETE privilege is REVOKEd from authenticated -> InsufficientPrivilege.
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "update public.evidence_objects set lift = 99 where evidence_id = %s",
                (EVIDENCE_A,),
            )
        conn.rollback()
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "delete from public.evidence_objects where evidence_id = %s",
                (EVIDENCE_A,),
            )
        conn.rollback()
    # row survived
    with as_user(USER_A) as conn, conn.cursor() as cur:
        cur.execute(
            "select count(*) from public.evidence_objects where evidence_id = %s",
            (EVIDENCE_A,),
        )
        assert cur.fetchone()[0] == 1
