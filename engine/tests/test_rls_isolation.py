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
import datetime
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

# Prospective layer (epic #6 child #7): decisions/predictions/revisions/transitions
DECISION_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e0")
DECISION_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f0")
PREDICTION_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e1")
PREDICTION_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f1")
REVISION_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e2")
REVISION_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f2")
TRANSITION_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e3")
TRANSITION_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f3")

# Cold-start layer (epic #13 child C1/#14): levers
LEVER_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e4")
LEVER_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f4")

# Decision Report Slice 4: durable report + append-only revision.
REPORT_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e5")
REPORT_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f5")
REPORT_REVISION_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e6")
REPORT_REVISION_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f6")
ACTIVATION_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e7")
ACTIVATION_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f7")
REPORT_ASSET_A = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e8")
REPORT_ASSET_B = uuid.UUID("bbbb0000-0000-0000-0000-0000000000f8")

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
    # Prospective layer — decision_actions/prediction_revisions/transition_events
    # carry no scope_id; their tenant resolves through the parent id.
    ("public.decisions", "scope_id", WS_A, WS_B),
    ("public.decision_actions", "decision_id", DECISION_A, DECISION_B),
    ("public.predictions", "scope_id", WS_A, WS_B),
    ("public.prediction_revisions", "prediction_id", PREDICTION_A, PREDICTION_B),
    ("public.transition_events", "action_id", ACTION_A, ACTION_B),
    # Cold-start layer — levers carry their own scope_id.
    ("public.levers", "scope_id", WS_A, WS_B),
    # Decision Report Slice 4 — both tables carry scope_id for direct RLS.
    ("public.decision_reports", "scope_id", WS_A, WS_B),
    ("public.decision_report_revisions", "scope_id", WS_A, WS_B),
    ("public.decision_report_activations", "scope_id", WS_A, WS_B),
    ("public.report_assets", "scope_id", WS_A, WS_B),
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

        # prospective layer: one row per tenant in each of the 5 new tables
        cur.execute(
            "insert into public.decisions (decision_id, scope_id, title) values "
            "(%s,%s,'d'),(%s,%s,'d')",
            (DECISION_A, WS_A, DECISION_B, WS_B),
        )
        cur.execute(
            "insert into public.decision_actions (decision_id, action_id) values "
            "(%s,%s),(%s,%s)",
            (DECISION_A, ACTION_A, DECISION_B, ACTION_B),
        )
        cur.execute(
            "insert into public.predictions (prediction_id, scope_id, decision_id, metric_id, "
            "direction, magnitude_pct_mean, resolution_date) values "
            "(%s,%s,%s,%s,'POSITIVE',3.0, date '2026-03-01'),"
            "(%s,%s,%s,%s,'POSITIVE',3.0, date '2026-03-01')",
            (PREDICTION_A, WS_A, DECISION_A, METRIC_A,
             PREDICTION_B, WS_B, DECISION_B, METRIC_B),
        )
        cur.execute(
            "insert into public.prediction_revisions (revision_id, prediction_id, "
            "old_magnitude, new_magnitude, reason) values "
            "(%s,%s,3.0,2.0,'r'),(%s,%s,3.0,2.0,'r')",
            (REVISION_A, PREDICTION_A, REVISION_B, PREDICTION_B),
        )
        cur.execute(
            "insert into public.transition_events (event_id, action_id, canonical, source, "
            "provider_event_id, transition_ts) values "
            "(%s,%s,'LEVER_SHIPPED','github','rls-evt-a', timestamptz '2026-01-02T00:00:00Z'),"
            "(%s,%s,'LEVER_SHIPPED','github','rls-evt-b', timestamptz '2026-01-02T00:00:00Z')",
            (TRANSITION_A, ACTION_A, TRANSITION_B, ACTION_B),
        )

        # cold-start layer: one lever per tenant (mechanism carrier for the
        # decision's prediction on the tenant's metric)
        cur.execute(
            "insert into public.levers (lever_id, scope_id, decision_id, action_id, "
            "metric_id, provenance_token, target_source, status) values "
            "(%s,%s,%s,%s,%s,'rls-lever-a','github','SHIPPED'),"
            "(%s,%s,%s,%s,%s,'rls-lever-b','github','SHIPPED')",
            (LEVER_A, WS_A, DECISION_A, ACTION_A, METRIC_A,
             LEVER_B, WS_B, DECISION_B, ACTION_B, METRIC_B),
        )

        # Decision Report Slice 4. Reports are inserted before their revisions,
        # then the current pointers are connected once both append-only rows exist.
        cur.execute(
            "insert into public.decision_reports (report_id, scope_id, title, status) values "
            "(%s,%s,'report a','draft'),(%s,%s,'report b','draft')",
            (REPORT_A, WS_A, REPORT_B, WS_B),
        )
        cur.execute(
            "insert into public.decision_report_revisions "
            "(revision_id, report_id, scope_id, revision_number, schema_version, snapshot, "
            "metric_projection, content_hash) values "
            "(%s,%s,%s,1,1,'{}'::jsonb,'{}'::jsonb,%s),"
            "(%s,%s,%s,1,1,'{}'::jsonb,'{}'::jsonb,%s)",
            (
                REPORT_REVISION_A, REPORT_A, WS_A, "a" * 32,
                REPORT_REVISION_B, REPORT_B, WS_B, "b" * 32,
            ),
        )
        cur.execute(
            "update public.decision_reports set current_revision_id = case "
            "when report_id = %s then %s when report_id = %s then %s end "
            "where report_id in (%s,%s)",
            (
                REPORT_A, REPORT_REVISION_A, REPORT_B, REPORT_REVISION_B,
                REPORT_A, REPORT_B,
            ),
        )
        cur.execute(
            "insert into public.report_assets "
            "(asset_id, report_id, scope_id, reserved_revision_id, attached_revision_id, object_path, media_type, byte_size, width, height, content_hash, status) values "
            "(%s,%s,%s,%s,%s,%s,'image/png',100,10,10,%s,'attached'),"
            "(%s,%s,%s,%s,%s,%s,'image/png',100,10,10,%s,'attached')",
            (
                REPORT_ASSET_A, REPORT_A, WS_A, REPORT_REVISION_A, REPORT_REVISION_A,
                f"{WS_A}/{REPORT_A}/{REPORT_ASSET_A}.png", "e" * 64,
                REPORT_ASSET_B, REPORT_B, WS_B, REPORT_REVISION_B, REPORT_REVISION_B,
                f"{WS_B}/{REPORT_B}/{REPORT_ASSET_B}.png", "f" * 64,
            ),
        )
        cur.execute(
            "insert into public.decision_report_activations "
            "(activation_id, report_id, revision_id, scope_id, input_hash, metric_id, "
            "prediction_direction, prediction_magnitude_pct_mean, prediction_resolution_date, "
            "selected_action_source_ids, decision_id, prediction_id, action_ids, activated_by) values "
            "(%s,%s,%s,%s,%s,%s,'POSITIVE',3.0,date '2026-03-01',array['seed-a'],%s,%s,array[%s]::uuid[],%s),"
            "(%s,%s,%s,%s,%s,%s,'POSITIVE',3.0,date '2026-03-01',array['seed-b'],%s,%s,array[%s]::uuid[],%s)",
            (
                ACTIVATION_A, REPORT_A, REPORT_REVISION_A, WS_A, "c" * 32, METRIC_A,
                DECISION_A, PREDICTION_A, ACTION_A, USER_A,
                ACTIVATION_B, REPORT_B, REPORT_REVISION_B, WS_B, "d" * 32, METRIC_B,
                DECISION_B, PREDICTION_B, ACTION_B, USER_B,
            ),
        )
        cur.execute(
            "update public.decision_reports set "
            "status='active', active_activation_id=case when report_id=%s then %s else %s end, "
            "active_decision_id=case when report_id=%s then %s else %s end, "
            "active_prediction_id=case when report_id=%s then %s else %s end, "
            "active_metric_id=case when report_id=%s then %s else %s end, "
            "activated_by=case when report_id=%s then %s else %s end, activated_at=now() "
            "where report_id in (%s,%s)",
            (
                REPORT_A, ACTIVATION_A, ACTIVATION_B,
                REPORT_A, DECISION_A, DECISION_B,
                REPORT_A, PREDICTION_A, PREDICTION_B,
                REPORT_A, METRIC_A, METRIC_B,
                REPORT_A, USER_A, USER_B,
                REPORT_A, REPORT_B,
            ),
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
    # sanity: 11 v1 + 5 prospective + levers + funnel/objective + 3 report tables.
    assert len(rows) >= 22, f"expected >=22 public tables, saw {len(rows)}"


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


# ============================================================================
# GATE 6 — Prospective layer (epic #6 child #7)
# ============================================================================
def test_member_cannot_insert_foreign_scope_prospective(seeded):
    # A member of org A must not create decisions or predictions in org B's scope.
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.decisions (scope_id, title) values (%s,'leak')",
                (WS_B,),
            )
        conn.rollback()
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.predictions (scope_id, decision_id, metric_id, "
                "direction, magnitude_pct_mean, resolution_date) values "
                "(%s,%s,%s,'POSITIVE',1.0, date '2026-03-01')",
                (WS_B, DECISION_B, METRIC_B),
            )
        conn.rollback()


def test_cross_scope_lever_link_blocked(seeded):
    # decision_actions scopes via BOTH parents: user A cannot link org B's action
    # into org A's decision (nor org A's action into org B's decision).
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.decision_actions (decision_id, action_id) values (%s,%s)",
                (DECISION_A, ACTION_B),
            )
        conn.rollback()
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.decision_actions (decision_id, action_id) values (%s,%s)",
                (DECISION_B, ACTION_A),
            )
        conn.rollback()


def test_prospective_logs_are_append_only(seeded):
    # prediction_revisions and transition_events mirror evidence_objects:
    # UPDATE/DELETE privilege is REVOKEd from authenticated.
    for stmt, params in [
        ("update public.prediction_revisions set reason = 'x' where revision_id = %s",
         (REVISION_A,)),
        ("delete from public.prediction_revisions where revision_id = %s",
         (REVISION_A,)),
        ("update public.transition_events set to_status = 'x' where event_id = %s",
         (TRANSITION_A,)),
        ("delete from public.transition_events where event_id = %s",
         (TRANSITION_A,)),
    ]:
        with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(pgerr.InsufficientPrivilege):
                cur.execute(stmt, params)
            conn.rollback()


def test_report_asset_bytes_require_member_rank(seeded):
    with as_user(USER_A_VIEWER) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.report_assets where asset_id=%s", (REPORT_ASSET_A,))
        assert cur.fetchone()[0] == 0
    with as_user(USER_A) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.report_assets where asset_id=%s", (REPORT_ASSET_A,))
        assert cur.fetchone()[0] == 1


# ============================================================================
# GATE 7 — Decision Report Slice 4 persistence boundary
# ============================================================================
READY_REPORT = {
    "schemaVersion": 1,
    "title": "AI assistant rollout",
    "decision": {
        "decision": [{"id": "d", "text": "Deploy it", "status": "user_confirmed", "sourceChunkIds": []}],
        "background": [],
        "problem": [{"id": "p", "text": "Users are blocked", "status": "user_confirmed", "sourceChunkIds": []}],
    },
    "supportingEvidence": {
        "factors": [{"id": "f", "text": "Sessions abandon", "status": "user_confirmed", "sourceChunkIds": []}],
        "metricMechanism": [{"id": "m", "text": "Completion should rise", "status": "user_confirmed", "sourceChunkIds": []}],
    },
    "implementation": {
        "actionPlanSummary": [{"id": "s", "text": "Instrument and ship", "status": "user_confirmed", "sourceChunkIds": []}],
        "actions": [{"sourceItemId": "a1", "title": "Instrument completion", "summary": [], "owner": None}],
        "customers": [],
        "stakeholders": [],
        "assetIds": [],
        "governance": {
            "dataClassification": None,
            "allowedDataSources": [],
            "approvedModelNotes": [],
        },
    },
}

READY_PROJECTION = {
    "metricName": "Completion rate",
    "definition": "Completed mixer sessions",
    "baselinePct": None,
    "predictedPct": None,
    "baselineLabel": "Missing",
    "predictionLabel": "Missing",
    "evidenceState": "missing",
}


def test_member_uses_checked_report_rpc_and_identical_retry_reuses(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "select report_id, revision_id, reused from public.create_decision_report_v1("
            "%s,%s,'report_ready',%s::jsonb,%s::jsonb,%s)",
            (WS_A, READY_REPORT["title"], json.dumps(READY_REPORT),
             json.dumps(READY_PROJECTION), USER_A),
        )
        report_id, revision_id, reused = cur.fetchone()
        assert reused is False

        cur.execute(
            "select revision_id, reused from public.append_decision_report_revision_v1("
            "%s,%s,%s,'report_ready',%s::jsonb,%s::jsonb,%s)",
            (report_id, revision_id, READY_REPORT["title"], json.dumps(READY_REPORT),
             json.dumps(READY_PROJECTION), USER_A),
        )
        retry_revision_id, retry_reused = cur.fetchone()
        assert retry_reused is True
        assert retry_revision_id == revision_id

        cur.execute(
            "select count(*) from public.decision_report_revisions where report_id=%s",
            (report_id,),
        )
        assert cur.fetchone()[0] == 1
        conn.rollback()


def test_report_rpc_denies_viewer_and_cross_tenant_member(seeded):
    for user_id, target_scope in [
        (USER_A_VIEWER, WS_A),
        (USER_A, WS_B),
    ]:
        with as_user(user_id, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(pgerr.InsufficientPrivilege):
                cur.execute(
                    "select * from public.create_decision_report_v1("
                    "%s,%s,'report_ready',%s::jsonb,%s::jsonb,%s)",
                    (target_scope, READY_REPORT["title"], json.dumps(READY_REPORT),
                     json.dumps(READY_PROJECTION), user_id),
                )
            conn.rollback()


def test_report_assets_are_member_scoped_and_viewer_or_cross_tenant_denied(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute("select asset_id from public.report_assets where asset_id=%s", (REPORT_ASSET_A,))
        assert cur.fetchone()[0] == REPORT_ASSET_A
        cur.execute("select count(*) from public.report_assets where asset_id=%s", (REPORT_ASSET_B,))
        assert cur.fetchone()[0] == 0
        conn.rollback()

    with as_user(USER_A_VIEWER, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.report_assets where asset_id=%s", (REPORT_ASSET_A,))
        assert cur.fetchone()[0] == 0
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "select * from public.reserve_decision_report_asset_v1(%s,%s,'png',%s)",
                (REPORT_A, REPORT_REVISION_A, USER_A_VIEWER),
            )
        conn.rollback()

    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "select * from public.reserve_decision_report_asset_v1(%s,%s,'png',%s)",
                (REPORT_B, REPORT_REVISION_B, USER_A),
            )
        conn.rollback()


def test_report_tables_are_read_only_and_revisions_append_only(seeded):
    statements = [
        ("insert into public.decision_reports (scope_id,title) values (%s,'blocked')", (WS_A,)),
        ("update public.decision_reports set title='blocked' where report_id=%s", (REPORT_A,)),
        ("delete from public.decision_reports where report_id=%s", (REPORT_A,)),
        ("update public.decision_report_revisions set snapshot='{}' where revision_id=%s", (REPORT_REVISION_A,)),
        ("delete from public.decision_report_revisions where revision_id=%s", (REPORT_REVISION_A,)),
    ]
    for statement, params in statements:
        with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(pgerr.InsufficientPrivilege):
                cur.execute(statement, params)
            conn.rollback()


def test_member_soft_deletes_non_active_report_and_retry_reuses(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "select report_id, revision_id from public.create_decision_report_v1("
            "%s,%s,'report_ready',%s::jsonb,%s::jsonb,%s)",
            (WS_A, READY_REPORT["title"], json.dumps(READY_REPORT),
             json.dumps(READY_PROJECTION), USER_A),
        )
        report_id, revision_id = cur.fetchone()
        cur.execute(
            "select report_id, reused from public.delete_decision_report_v1(%s,%s,%s)",
            (WS_A, report_id, USER_A),
        )
        assert cur.fetchone() == (report_id, False)
        cur.execute(
            "select report_id, reused from public.delete_decision_report_v1(%s,%s,%s)",
            (WS_A, report_id, USER_A),
        )
        assert cur.fetchone() == (report_id, True)
        cur.execute("select count(*) from public.decision_reports where report_id=%s", (report_id,))
        assert cur.fetchone()[0] == 0
        cur.execute(
            "select count(*) from public.decision_report_revisions where revision_id=%s",
            (revision_id,),
        )
        assert cur.fetchone()[0] == 0
        conn.rollback()


def test_report_delete_denies_viewer_and_cross_tenant_member(seeded):
    for user_id, scope_id, report_id in (
        (USER_A_VIEWER, WS_A, REPORT_A),
        (USER_A, WS_A, REPORT_B),
    ):
        with as_user(user_id, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(psycopg.Error):
                cur.execute(
                    "select * from public.delete_decision_report_v1(%s,%s,%s)",
                    (scope_id, report_id, user_id),
                )
            conn.rollback()


def test_active_report_can_leave_history_without_deleting_graph_audit(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "select report_id, reused from public.delete_decision_report_v1(%s,%s,%s)",
            (WS_A, REPORT_A, USER_A),
        )
        assert cur.fetchone() == (REPORT_A, False)
        cur.execute("select count(*) from public.decision_reports where report_id=%s", (REPORT_A,))
        assert cur.fetchone()[0] == 0
        cur.execute("select count(*) from public.decisions where decision_id=%s", (DECISION_A,))
        assert cur.fetchone()[0] == 1
        cur.execute("select count(*) from public.actions where action_id=%s", (ACTION_A,))
        assert cur.fetchone()[0] == 1
        conn.rollback()


def test_member_activates_reviewed_report_once_and_retry_reuses(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "select report_id, revision_id from public.create_decision_report_v1("
            "%s,%s,'report_ready',%s::jsonb,%s::jsonb,%s)",
            (WS_A, READY_REPORT["title"], json.dumps(READY_REPORT),
             json.dumps(READY_PROJECTION), USER_A),
        )
        report_id, revision_id = cur.fetchone()

        cur.execute(
            "select activation_id, decision_id, prediction_id, action_ids, reused "
            "from public.activate_decision_report_v1("
            "%s,%s,%s,'POSITIVE',15.0,date '2026-12-15',array['a1'],%s)",
            (report_id, revision_id, METRIC_A, USER_A),
        )
        activation_id, decision_id, prediction_id, action_ids, reused = cur.fetchone()
        assert reused is False
        assert len(action_ids) == 1

        cur.execute(
            "select activation_id, decision_id, prediction_id, action_ids, reused "
            "from public.activate_decision_report_v1("
            "%s,%s,%s,'POSITIVE',15.0,date '2026-12-15',array['a1'],%s)",
            (report_id, revision_id, METRIC_A, USER_A),
        )
        retry = cur.fetchone()
        assert retry == (activation_id, decision_id, prediction_id, action_ids, True)

        cur.execute(
            "select status, active_activation_id, active_decision_id, active_prediction_id "
            "from public.decision_reports where report_id=%s",
            (report_id,),
        )
        assert cur.fetchone() == ("active", activation_id, decision_id, prediction_id)
        cur.execute("select count(*) from public.levers where decision_id=%s", (decision_id,))
        assert cur.fetchone()[0] == 0
        conn.rollback()


def test_activation_rpc_denies_viewer_cross_tenant_and_changed_retry(seeded):
    # The function re-authenticates and checks member access even though it is
    # SECURITY DEFINER. A viewer cannot activate their own tenant's report, and
    # an org-A member cannot activate org B's report.
    for user_id, report_id, revision_id, metric_id in [
        (USER_A_VIEWER, REPORT_A, REPORT_REVISION_A, METRIC_A),
        (USER_A, REPORT_B, REPORT_REVISION_B, METRIC_B),
    ]:
        with as_user(user_id, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(pgerr.InsufficientPrivilege):
                cur.execute(
                    "select * from public.activate_decision_report_v1("
                    "%s,%s,%s,'POSITIVE',3.0,date '2026-12-15',array['seed-a'],%s)",
                    (report_id, revision_id, metric_id, user_id),
                )
            conn.rollback()

    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "select report_id, revision_id from public.create_decision_report_v1("
            "%s,%s,'report_ready',%s::jsonb,%s::jsonb,%s)",
            (WS_A, READY_REPORT["title"], json.dumps(READY_REPORT),
             json.dumps(READY_PROJECTION), USER_A),
        )
        report_id, revision_id = cur.fetchone()
        cur.execute(
            "select * from public.activate_decision_report_v1("
            "%s,%s,%s,'POSITIVE',15.0,date '2026-12-15',array['a1'],%s)",
            (report_id, revision_id, METRIC_A, USER_A),
        )
        with pytest.raises(psycopg.Error) as conflict:
            cur.execute(
                "select * from public.activate_decision_report_v1("
                "%s,%s,%s,'POSITIVE',20.0,date '2026-12-15',array['a1'],%s)",
                (report_id, revision_id, METRIC_A, USER_A),
            )
        assert conflict.value.sqlstate == "PT409"
        conn.rollback()


def test_activation_table_is_read_only_to_authenticated(seeded):
    statements = [
        ("update public.decision_report_activations set input_hash=%s where activation_id=%s", ("e" * 32, ACTIVATION_A)),
        ("delete from public.decision_report_activations where activation_id=%s", (ACTIVATION_A,)),
    ]
    for statement, params in statements:
        with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(pgerr.InsufficientPrivilege):
                cur.execute(statement, params)
            conn.rollback()


# ============================================================================
# GATE 8 — Slice 7 active-report metric CSV import authorization
# ============================================================================
def _import_active_metric(cur, scope_id, report_id, metric_id, actor_id, value=7):
    cur.execute(
        "select * from public.import_active_report_metric_csv_v1("
        "%s,%s,%s,%s::jsonb,%s)",
        (
            scope_id,
            report_id,
            metric_id,
            json.dumps([{"date": "2026-07-22", "value": value}]),
            actor_id,
        ),
    )
    return cur.fetchone()


def test_active_report_metric_import_member_only_and_idempotent(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        first = _import_active_metric(cur, WS_A, REPORT_A, METRIC_A, USER_A)
        assert first[2:5] == (1, 1, 0)
        retry = _import_active_metric(cur, WS_A, REPORT_A, METRIC_A, USER_A, value=8)
        assert retry[2:5] == (1, 0, 1)
        cur.execute(
            "select count(*), max(value) from public.metric_observations "
            "where metric_id=%s and obs_date=date '2026-07-22'",
            (METRIC_A,),
        )
        assert cur.fetchone() == (1, 8)
        conn.rollback()


def test_active_report_metric_import_rejects_viewer_and_cross_workspace(seeded):
    with as_user(USER_A_VIEWER, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            _import_active_metric(cur, WS_A, REPORT_A, METRIC_A, USER_A_VIEWER)
        conn.rollback()
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        for scope_id, report_id, metric_id in (
            (WS_A, REPORT_A, METRIC_B),
            (WS_B, REPORT_B, METRIC_B),
            (WS_A, REPORT_B, METRIC_A),
        ):
            with pytest.raises(pgerr.InsufficientPrivilege):
                _import_active_metric(cur, scope_id, report_id, metric_id, USER_A)
            conn.rollback()


def test_workspace_core_metric_selection_is_member_only_and_scope_bound(seeded):
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "select selected_metric_id,is_core,core_metric_count "
            "from public.set_workspace_core_metric_v1(%s,%s,true,%s)",
            (WS_A, METRIC_A, USER_A),
        )
        assert cur.fetchone() == (METRIC_A, True, 1)
        cur.execute(
            "select selected_metric_id,is_core,core_metric_count "
            "from public.set_workspace_core_metric_v1(%s,%s,false,%s)",
            (WS_A, METRIC_A, USER_A),
        )
        assert cur.fetchone() == (METRIC_A, False, 0)
        conn.rollback()

    for user_id, scope_id, metric_id, actor_id in (
        (USER_A_VIEWER, WS_A, METRIC_A, USER_A_VIEWER),
        (USER_A, WS_B, METRIC_B, USER_A),
    ):
        with as_user(user_id, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(pgerr.InsufficientPrivilege):
                cur.execute(
                    "select * from public.set_workspace_core_metric_v1(%s,%s,true,%s)",
                    (scope_id, metric_id, actor_id),
                )
            conn.rollback()


def test_workspace_core_metric_selection_enforces_five_metric_cap(seeded):
    metric_ids = [uuid.uuid4() for _ in range(6)]
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        for index, metric_id in enumerate(metric_ids):
            cur.execute(
                "insert into public.metrics (metric_id,scope_id,name,source,granularity) "
                "values (%s,%s,%s,'csv','daily')",
                (metric_id, WS_A, f"core-{index}"),
            )
        for metric_id in metric_ids[:5]:
            cur.execute(
                "select core_metric_count from public.set_workspace_core_metric_v1(%s,%s,true,%s)",
                (WS_A, metric_id, USER_A),
            )
        assert cur.fetchone()[0] == 5
        with pytest.raises(pgerr.InvalidParameterValue):
            cur.execute(
                "select * from public.set_workspace_core_metric_v1(%s,%s,true,%s)",
                (WS_A, metric_ids[5], USER_A),
            )
        conn.rollback()


def test_actions_source_accepts_jira_rejects_unknown(seeded):
    # The widened CHECK admits 'jira' and still rejects a bogus value.
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "insert into public.actions (scope_id, source) values (%s,'jira')", (WS_A,)
        )
        assert cur.rowcount == 1
        conn.rollback()  # keep the seed pristine
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.CheckViolation):
            cur.execute(
                "insert into public.actions (scope_id, source) values (%s,'gitlab')",
                (WS_A,),
            )
        conn.rollback()


def test_manual_report_action_completion_is_member_only_scoped_and_idempotent(seeded):
    action_id = uuid.UUID("aaaa0000-0000-0000-0000-0000000000cb")
    rationale = json.dumps({
        "type": "doc",
        "content": [],
        "meta": {"source": "decision_report", "source_item_id": "manual-test"},
    })
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "insert into public.actions (action_id,scope_id,source,status,rationale_richtext) "
            "values (%s,%s,'manual','planned',%s::jsonb)",
            (action_id, WS_A, rationale),
        )
        cur.execute(
            "select completed_on, explanation, reused from public.complete_manual_action_v1("
            "%s,%s,date '2026-07-22','Shipped outside the tracker.',%s)",
            (WS_A, action_id, USER_A),
        )
        assert cur.fetchone() == (
            datetime.date(2026, 7, 22),
            "Shipped outside the tracker.",
            False,
        )
        cur.execute(
            "select completed_on, explanation, reused from public.complete_manual_action_v1("
            "%s,%s,date '2026-07-22','Shipped outside the tracker.',%s)",
            (WS_A, action_id, USER_A),
        )
        assert cur.fetchone()[2] is True
        cur.execute(
            "select effective_date,status,rationale_richtext #>> '{meta,manual_completion,explanation}' "
            "from public.actions where action_id=%s",
            (action_id,),
        )
        assert cur.fetchone() == (
            datetime.date(2026, 7, 22),
            "complete",
            "Shipped outside the tracker.",
        )
        conn.rollback()

    for user_id, scope_id, target_action, actor_id in (
        (USER_A_VIEWER, WS_A, ACTION_A, USER_A_VIEWER),
        (USER_A, WS_B, ACTION_B, USER_A),
    ):
        with as_user(user_id, autocommit=False) as conn, conn.cursor() as cur:
            with pytest.raises(pgerr.InsufficientPrivilege):
                cur.execute(
                    "select * from public.complete_manual_action_v1("
                    "%s,%s,date '2026-07-22','Not allowed.',%s)",
                    (scope_id, target_action, actor_id),
                )
            conn.rollback()


# ============================================================================
# GATE 8 — Cold-start levers (epic #13 child C1/#14)
# ============================================================================
def test_levers_member_reads_and_writes_own_scope(seeded):
    # A member can read the scope's levers and insert/update new ones; a viewer
    # can read but not write (mirrors the metrics/objectives policy shape).
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.levers where scope_id = %s", (WS_A,))
        assert cur.fetchone()[0] == 1
        cur.execute(
            "insert into public.levers (scope_id, decision_id, action_id, metric_id, "
            "provenance_token, target_source) values (%s,%s,%s,%s,'rls-lever-a2','github')",
            (WS_A, DECISION_A, ACTION_A, METRIC_A),
        )
        assert cur.rowcount == 1
        cur.execute(
            "update public.levers set status = 'CREATED' "
            "where provenance_token = 'rls-lever-a2'"
        )
        assert cur.rowcount == 1
        conn.rollback()  # keep the seed pristine
    with as_user(USER_A_VIEWER, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.levers where scope_id = %s", (WS_A,))
        assert cur.fetchone()[0] == 1
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.levers (scope_id, decision_id, action_id, metric_id, "
                "provenance_token, target_source) values (%s,%s,%s,%s,'rls-lever-vw','github')",
                (WS_A, DECISION_A, ACTION_A, METRIC_A),
            )
        conn.rollback()


def test_levers_cross_tenant_denied(seeded):
    # User A sees zero of org B's levers and cannot insert into org B's scope.
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.levers where scope_id = %s", (WS_B,))
        assert cur.fetchone()[0] == 0
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.levers (scope_id, decision_id, action_id, metric_id, "
                "provenance_token, target_source) values (%s,%s,%s,%s,'rls-lever-x','github')",
                (WS_B, DECISION_B, ACTION_B, METRIC_B),
            )
        conn.rollback()


def test_levers_same_metric_double_insert_allowed(seeded):
    # NO unique(decision_id, metric_id): two levers on one (decision, metric)
    # both insert (the C4 cluster path resolves them).
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "insert into public.levers (scope_id, decision_id, action_id, metric_id, "
            "provenance_token, target_source) values "
            "(%s,%s,%s,%s,'rls-lever-m1','github'),"
            "(%s,%s,%s,%s,'rls-lever-m2','github')",
            (WS_A, DECISION_A, ACTION_A, METRIC_A,
             WS_A, DECISION_A, ACTION_A, METRIC_A),
        )
        assert cur.rowcount == 2
        # provenance_token stays the idempotency key: a duplicate token is refused.
        with pytest.raises(pgerr.UniqueViolation):
            cur.execute(
                "insert into public.levers (scope_id, decision_id, action_id, metric_id, "
                "provenance_token, target_source) values (%s,%s,%s,%s,'rls-lever-m1','github')",
                (WS_A, DECISION_A, ACTION_A, METRIC_A),
            )
        conn.rollback()


def test_cold_start_enum_values(seeded):
    # metrics.source admits 'declared' (and still rejects a bogus value);
    # predictions.resolved_verdict admits 'UNMEASURABLE_NO_METRIC';
    # levers.status/target_source reject values outside the lifecycle.
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "insert into public.metrics (scope_id, name, source) values (%s,'declared m','declared')",
            (WS_A,),
        )
        assert cur.rowcount == 1
        conn.rollback()
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.CheckViolation):
            cur.execute(
                "insert into public.metrics (scope_id, name, source) values (%s,'bad','psychic')",
                (WS_A,),
            )
        conn.rollback()
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "update public.predictions set resolved_verdict = 'UNMEASURABLE_NO_METRIC' "
            "where prediction_id = %s",
            (PREDICTION_A,),
        )
        assert cur.rowcount == 1
        conn.rollback()
    with as_user(USER_A, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.CheckViolation):
            cur.execute(
                "insert into public.levers (scope_id, decision_id, action_id, metric_id, "
                "provenance_token, target_source, status) values "
                "(%s,%s,%s,%s,'rls-lever-bad','github','TELEPORTED')",
                (WS_A, DECISION_A, ACTION_A, METRIC_A),
            )
        conn.rollback()


def test_decision_delete_cascades_to_children(seeded):
    # FK cascade: deleting a decision removes its decision_actions + predictions.
    # Scratch rows only — the seeded decisions stay pristine.
    scratch_decision = uuid.UUID("aaaa0000-0000-0000-0000-0000000000e9")
    scratch_prediction = uuid.UUID("aaaa0000-0000-0000-0000-0000000000ea")
    with seeded.cursor() as cur:
        cur.execute(
            "insert into public.decisions (decision_id, scope_id, title) values (%s,%s,'scratch')",
            (scratch_decision, WS_A),
        )
        cur.execute(
            "insert into public.decision_actions (decision_id, action_id) values (%s,%s)",
            (scratch_decision, ACTION_A),
        )
        cur.execute(
            "insert into public.predictions (prediction_id, scope_id, decision_id, metric_id, "
            "direction, magnitude_pct_mean, resolution_date) values "
            "(%s,%s,%s,%s,'POSITIVE',1.0, date '2026-03-01')",
            (scratch_prediction, WS_A, scratch_decision, METRIC_A),
        )
        cur.execute(
            "delete from public.decisions where decision_id = %s", (scratch_decision,)
        )
        cur.execute(
            "select count(*) from public.decision_actions where decision_id = %s",
            (scratch_decision,),
        )
        assert cur.fetchone()[0] == 0
        cur.execute(
            "select count(*) from public.predictions where prediction_id = %s",
            (scratch_prediction,),
        )
        assert cur.fetchone()[0] == 0
