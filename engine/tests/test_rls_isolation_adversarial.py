"""Adversarial RLS probes — the surface test_rls_isolation.py does NOT cover.

The base gate seeds ONLY org-level member/viewer grants. This file seeds the
untested shapes and hunts for a cross-tenant LEAK or a role/scope ESCALATION:

  * workspace-scoped and project-scoped memberships (sibling-workspace and
    sibling-project isolation — the "checks org but not the specific scope" hole)
  * membership self-service escalation (can a plain member grant themselves a
    role? can a project-admin widen to org-wide or jump to a sibling project?)
  * the anon role (policies are `to authenticated` only)
  * UPDATE-side cross-tenant move (WITH CHECK on the new scope_id)
  * SECURITY DEFINER helper reachability (metric_scope over a foreign metric)

Run: engine/.venv/bin/python -m pytest tests/test_rls_isolation_adversarial.py -q
Against: postgresql://postgres:postgres@127.0.0.1:54322/postgres
"""

from __future__ import annotations

import contextlib
import json
import uuid

import psycopg
import pytest
from psycopg import errors as pgerr

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Namespaced seed ids (c*/d* so they never collide with the base gate's a*/b*).
ORG_C = uuid.UUID("cccc0000-0000-0000-0000-0000000000c0")
ORG_D = uuid.UUID("dddd0000-0000-0000-0000-0000000000d0")
# org C: two projects; P1 has two workspaces; P2 has one.
PROJ_C1 = uuid.UUID("cccc0000-0000-0000-0000-0000000000c1")
PROJ_C2 = uuid.UUID("cccc0000-0000-0000-0000-0000000000c2")
WS_C1A = uuid.UUID("cccc0000-0000-0000-0000-00000000c1a0")
WS_C1B = uuid.UUID("cccc0000-0000-0000-0000-00000000c1b0")
WS_C2 = uuid.UUID("cccc0000-0000-0000-0000-00000000c200")
# org D: separate tenant
PROJ_D1 = uuid.UUID("dddd0000-0000-0000-0000-0000000000d1")
WS_D = uuid.UUID("dddd0000-0000-0000-0000-00000000d100")

# metrics per workspace
M_C1A = uuid.UUID("cccc0000-0000-0000-0000-00000000c1a1")
M_C1B = uuid.UUID("cccc0000-0000-0000-0000-00000000c1b1")
M_C2 = uuid.UUID("cccc0000-0000-0000-0000-00000000c201")
M_D = uuid.UUID("dddd0000-0000-0000-0000-00000000d101")

# users
U_WS_MEMBER = uuid.UUID("cccc1111-0000-0000-0000-0000000000f1")   # member @ WS_C1A only
U_PROJ_ADMIN = uuid.UUID("cccc1111-0000-0000-0000-0000000000f2")  # admin  @ PROJ_C1
U_ORG_MEMBER = uuid.UUID("cccc1111-0000-0000-0000-0000000000f3")  # member @ ORG_C
U_ORG_ADMIN = uuid.UUID("cccc1111-0000-0000-0000-0000000000f4")   # admin  @ ORG_C
U_D_MEMBER = uuid.UUID("dddd1111-0000-0000-0000-0000000000f5")    # member @ ORG_D

ALL_USERS = (U_WS_MEMBER, U_PROJ_ADMIN, U_ORG_MEMBER, U_ORG_ADMIN, U_D_MEMBER)


def _su() -> psycopg.Connection:
    c = psycopg.connect(DSN)
    c.autocommit = True
    return c


@contextlib.contextmanager
def as_user(user_id: uuid.UUID, autocommit: bool = True):
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


@contextlib.contextmanager
def as_anon(autocommit: bool = True):
    conn = psycopg.connect(DSN)
    conn.autocommit = autocommit
    try:
        with conn.cursor() as cur:
            cur.execute("set role anon")
            claims = json.dumps({"role": "anon"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        yield conn
    finally:
        conn.close()


def _teardown(conn):
    with conn.cursor() as cur:
        cur.execute("delete from public.orgs where org_id = any(%s)", ([ORG_C, ORG_D],))
        cur.execute("delete from auth.users where id = any(%s)", (list(ALL_USERS),))


def _seed(conn):
    with conn.cursor() as cur:
        for uid in ALL_USERS:
            cur.execute("insert into auth.users (id) values (%s)", (uid,))
        cur.execute("insert into public.orgs (org_id, name) values (%s,'C'),(%s,'D')", (ORG_C, ORG_D))
        cur.execute(
            "insert into public.projects (project_id, org_id, name) values (%s,%s,'C1'),(%s,%s,'C2'),(%s,%s,'D1')",
            (PROJ_C1, ORG_C, PROJ_C2, ORG_C, PROJ_D1, ORG_D),
        )
        cur.execute(
            "insert into public.workspaces (workspace_id, project_id, name) values "
            "(%s,%s,'C1A'),(%s,%s,'C1B'),(%s,%s,'C2'),(%s,%s,'D')",
            (WS_C1A, PROJ_C1, WS_C1B, PROJ_C1, WS_C2, PROJ_C2, WS_D, PROJ_D1),
        )
        # memberships of the untested shapes
        cur.execute(
            "insert into public.memberships (user_id, org_id, project_id, workspace_id, role) values "
            "(%s,%s,%s,%s,'member'),"   # workspace-scoped member @ C1A
            "(%s,%s,%s,NULL,'admin'),"  # project-scoped admin @ C1
            "(%s,%s,NULL,NULL,'member')," # org-scoped member @ C
            "(%s,%s,NULL,NULL,'admin'),"  # org-scoped admin @ C
            "(%s,%s,NULL,NULL,'member')", # org-scoped member @ D
            (U_WS_MEMBER, ORG_C, PROJ_C1, WS_C1A,
             U_PROJ_ADMIN, ORG_C, PROJ_C1,
             U_ORG_MEMBER, ORG_C,
             U_ORG_ADMIN, ORG_C,
             U_D_MEMBER, ORG_D),
        )
        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source) values "
            "(%s,%s,'m','csv'),(%s,%s,'m','csv'),(%s,%s,'m','csv'),(%s,%s,'m','csv')",
            (M_C1A, WS_C1A, M_C1B, WS_C1B, M_C2, WS_C2, M_D, WS_D),
        )


@pytest.fixture(scope="module")
def seeded():
    conn = _su()
    _teardown(conn)
    _seed(conn)
    try:
        yield conn
    finally:
        _teardown(conn)
        conn.close()


def _visible_metrics(cur, metric_id):
    cur.execute("select count(*) from public.metrics where metric_id = %s", (metric_id,))
    return cur.fetchone()[0]


# --- P1: sibling-workspace / sibling-project isolation for a workspace member --
def test_ws_member_sees_only_own_workspace(seeded):
    leaks = []
    with as_user(U_WS_MEMBER) as conn, conn.cursor() as cur:
        if _visible_metrics(cur, M_C1A) != 1:
            leaks.append("ws-member cannot see OWN workspace metric (over-block)")
        if _visible_metrics(cur, M_C1B) != 0:
            leaks.append("ws-member @C1A LEAKS sibling-workspace C1B metric")
        if _visible_metrics(cur, M_C2) != 0:
            leaks.append("ws-member @C1A LEAKS sibling-project C2 metric")
        if _visible_metrics(cur, M_D) != 0:
            leaks.append("ws-member @C1A LEAKS cross-org D metric")
    assert leaks == [], "; ".join(leaks)


# --- P2: project-scoped admin isolation on reads ------------------------------
def test_proj_admin_sees_only_own_project(seeded):
    leaks = []
    with as_user(U_PROJ_ADMIN) as conn, conn.cursor() as cur:
        if _visible_metrics(cur, M_C1A) != 1 or _visible_metrics(cur, M_C1B) != 1:
            leaks.append("proj-admin cannot see its own project's workspaces (over-block)")
        if _visible_metrics(cur, M_C2) != 0:
            leaks.append("proj-admin @C1 LEAKS sibling-project C2 metric")
        if _visible_metrics(cur, M_D) != 0:
            leaks.append("proj-admin @C1 LEAKS cross-org D metric")
    assert leaks == [], "; ".join(leaks)


# --- ESCALATION: a plain member cannot grant themselves ANY membership --------
def test_org_member_cannot_self_grant(seeded):
    with as_user(U_ORG_MEMBER, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.memberships (user_id, org_id, role) values (%s,%s,'owner')",
                (U_ORG_MEMBER, ORG_C),
            )
        conn.rollback()


# --- ESCALATION: project-admin cannot widen to org-wide or jump projects ------
def test_proj_admin_cannot_widen_scope(seeded):
    with as_user(U_PROJ_ADMIN, autocommit=False) as conn, conn.cursor() as cur:
        # widen to org-wide (project/workspace NULL) => must be blocked
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.memberships (user_id, org_id, role) values (%s,%s,'owner')",
                (U_PROJ_ADMIN, ORG_C),
            )
        conn.rollback()
    with as_user(U_PROJ_ADMIN, autocommit=False) as conn, conn.cursor() as cur:
        # jump to sibling project C2 => must be blocked
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.memberships (user_id, org_id, project_id, role) values (%s,%s,%s,'admin')",
                (U_PROJ_ADMIN, ORG_C, PROJ_C2),
            )
        conn.rollback()
    with as_user(U_PROJ_ADMIN, autocommit=False) as conn, conn.cursor() as cur:
        # within own project C1 => allowed (grant a workspace-level member)
        cur.execute(
            "insert into public.memberships (user_id, org_id, project_id, role) values (%s,%s,%s,'member')",
            (U_D_MEMBER, ORG_C, PROJ_C1),
        )
        assert cur.rowcount == 1
        conn.rollback()


# --- ESCALATION: org-admin CANNOT grant/self-upgrade a membership to 'owner' ---
def test_org_admin_cannot_self_grant_owner(seeded):
    """The membership WITH CHECK caps the granted role at the granter's own rank
    (`has_scope_grant(scope, role)` alongside the admin floor). An org-admin
    (rank 3) therefore cannot mint or self-upgrade any membership to 'owner'
    (rank 4) — that requires already holding owner over the scope. This closes
    the admin->owner self-escalation past the reserved owner>admin boundary."""
    # self-upgrade own org-wide row admin->owner => blocked by WITH CHECK
    with as_user(U_ORG_ADMIN, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "update public.memberships set role='owner' "
                "where user_id=%s and org_id=%s and project_id is null and workspace_id is null",
                (U_ORG_ADMIN, ORG_C),
            )
        conn.rollback()
    # mint a fresh 'owner' grant for another user => also blocked
    with as_user(U_ORG_ADMIN, autocommit=False) as conn, conn.cursor() as cur:
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "insert into public.memberships (user_id, org_id, role) values (%s,%s,'owner')",
                (U_D_MEMBER, ORG_C),
            )
        conn.rollback()
    # within-rank grant (admin grants 'admin') still works => no over-block
    with as_user(U_ORG_ADMIN, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute(
            "insert into public.memberships (user_id, org_id, role) values (%s,%s,'admin')",
            (U_D_MEMBER, ORG_C),
        )
        assert cur.rowcount == 1
        conn.rollback()
    # the org-admin's own row is unchanged (still 'admin')
    with seeded.cursor() as cur:
        cur.execute(
            "select role from public.memberships "
            "where user_id=%s and org_id=%s and project_id is null and workspace_id is null",
            (U_ORG_ADMIN, ORG_C),
        )
        assert cur.fetchone()[0] == "admin", "admin->owner self-grant must not persist"


# --- anon role: policies are `to authenticated` only -> anon must see nothing --
def test_anon_sees_no_rows(seeded):
    with as_anon() as conn, conn.cursor() as cur:
        for m in (M_C1A, M_C1B, M_C2, M_D):
            assert _visible_metrics(cur, m) == 0, "anon LEAK: unauthenticated read"


# --- UPDATE-side cross-tenant move: WITH CHECK on the destination scope --------
def test_update_cannot_move_row_cross_tenant(seeded):
    with as_user(U_ORG_MEMBER, autocommit=False) as conn, conn.cursor() as cur:
        # try to relocate C's metric into org D's workspace
        with pytest.raises(pgerr.InsufficientPrivilege):
            cur.execute(
                "update public.metrics set scope_id = %s where metric_id = %s",
                (WS_D, M_C1A),
            )
        conn.rollback()


# --- SECURITY DEFINER reachability: metric_scope over a FOREIGN metric ---------
def test_metric_scope_gates_foreign_scope_uuid(seeded):
    """metric_scope() is SECURITY DEFINER, so it gates its own return on
    has_scope_access(viewer): a foreign-tenant caller gets NULL (no cross-tenant
    metric_id -> workspace_id leak), while a caller with access still resolves
    its own metric's scope so the metric_observations policies keep working."""
    # foreign-org member cannot resolve org C's metric scope
    with as_user(U_D_MEMBER) as conn, conn.cursor() as cur:
        cur.execute("select public.metric_scope(%s)", (M_C1A,))
        assert cur.fetchone()[0] is None, "metric_scope leaks foreign scope (definer bypass)"
    # a legitimate member of WS_C1A still resolves its own metric's scope
    with as_user(U_WS_MEMBER) as conn, conn.cursor() as cur:
        cur.execute("select public.metric_scope(%s)", (M_C1A,))
        assert cur.fetchone()[0] == WS_C1A, "metric_scope over-blocks the owner (should resolve)"
