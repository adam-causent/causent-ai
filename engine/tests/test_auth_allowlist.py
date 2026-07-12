"""Live gate for the invite-only auth allowlist (issue #5).

Runs against the local Supabase Postgres. Google OAuth makes sign-in == sign-up,
so "invite-only" is enforced by two DB objects created in
supabase/migrations/*_auth_allowlist.sql:

  * enforce_allowlist(event jsonb) — the GoTrue Before-User-Created hook. A real
    Google click-through is a deferred human step, so we call the function
    DIRECTLY with the synthetic event payload GoTrue would pass (email nested at
    event->'user'->>'email', the shape verified against the current Supabase
    docs). Allowlisted → '{}'; stranger → an {error:{http_code,message}} object
    that makes GoTrue abort the insert (no orphan auth.users row).

  * handle_new_user() — an AFTER INSERT trigger on auth.users. We exercise it the
    way the issue's testing plan prescribes: INSERT directly into auth.users and
    assert the membership it materializes.

Then two RLS reads (acting AS the provisioned user vs a stranger) prove the
provisioned partner sees the seeded tenant and a non-member sees zero rows —
the same has_scope_access boundary the app now relies on after the RLS-client
swap. Nothing here is weakened to pass; a real regression fails the gate.
"""

from __future__ import annotations

import contextlib
import json
import uuid

import psycopg
import pytest

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# --- Scratch tenant (namespaced 'a11c' = allowlist; teardown is exact) ---------
ORG = uuid.UUID("a11c0000-0000-0000-0000-0000000000a0")
PROJ = uuid.UUID("a11c0000-0000-0000-0000-0000000000a1")
WS = uuid.UUID("a11c0000-0000-0000-0000-0000000000a2")
METRIC = uuid.UUID("a11c0000-0000-0000-0000-0000000000a3")

PARTNER = uuid.UUID("a11c1111-0000-0000-0000-0000000000a9")  # allowlisted
STRANGER = uuid.UUID("a11c2222-0000-0000-0000-0000000000a8")  # not allowlisted
PARTNER_EMAIL = "partner@allowlist.test"
STRANGER_EMAIL = "stranger@allowlist.test"
ALL_USERS = (PARTNER, STRANGER)


# --- Connection helpers -------------------------------------------------------
def _superuser_conn() -> psycopg.Connection:
    conn = psycopg.connect(DSN)
    conn.autocommit = True
    return conn


@contextlib.contextmanager
def as_user(user_id: uuid.UUID):
    """Fresh connection acting AS `user_id` under RLS (role=authenticated)."""
    conn = psycopg.connect(DSN)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("set role authenticated")
            claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
            cur.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        yield conn
    finally:
        conn.close()


def _teardown(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from public.orgs where org_id = %s", (ORG,))  # cascades
        cur.execute("delete from auth.users where id = any(%s)", (list(ALL_USERS),))
        cur.execute(
            "delete from public.allowed_emails where email = any(%s)",
            ([PARTNER_EMAIL, STRANGER_EMAIL],),
        )


def _seed(conn: psycopg.Connection) -> None:
    """Scratch org + one seed metric + the partner's invite. Users are created
    by the tests themselves (that is what fires the trigger)."""
    with conn.cursor() as cur:
        cur.execute("insert into public.orgs (org_id, name) values (%s,%s)", (ORG, "ALLOWLIST_TEST_org"))
        cur.execute(
            "insert into public.projects (project_id, org_id, name) values (%s,%s,%s)",
            (PROJ, ORG, "p"),
        )
        cur.execute(
            "insert into public.workspaces (workspace_id, project_id, name) values (%s,%s,%s)",
            (WS, PROJ, "w"),
        )
        # a seed row the provisioned partner should be able to read (and the
        # stranger must not).
        cur.execute(
            "insert into public.metrics (metric_id, scope_id, name, source) values (%s,%s,'seed','csv')",
            (METRIC, WS),
        )
        # invite the partner as a viewer on the org (mirrors the invite CLI).
        cur.execute(
            "insert into public.allowed_emails (email, org_id, role) values (%s,%s,'viewer')",
            (PARTNER_EMAIL, ORG),
        )


@pytest.fixture()
def seeded():
    conn = _superuser_conn()
    _teardown(conn)  # clean any residue from a prior aborted run
    _seed(conn)
    try:
        yield conn
    finally:
        _teardown(conn)
        conn.close()


def _event(email) -> str:
    """The synthetic Before-User-Created payload (email nested under 'user')."""
    return json.dumps({"user": {"email": email}} if email is not None else {"user": {}})


# ============================================================================
# UNIT — enforce_allowlist (the hook decision function)
# ============================================================================
def test_enforce_allowlist_rejects_non_allowlisted(seeded):
    with seeded.cursor() as cur:
        cur.execute("select public.enforce_allowlist(%s::jsonb)", (_event(STRANGER_EMAIL),))
        result = cur.fetchone()[0]
    assert "error" in result, f"stranger should be rejected, got {result}"
    assert result["error"]["http_code"] == 403


def test_enforce_allowlist_allows_allowlisted_case_insensitive(seeded):
    with seeded.cursor() as cur:
        # Upper-cased to prove the lower(email) compare in the function.
        cur.execute("select public.enforce_allowlist(%s::jsonb)", (_event(PARTNER_EMAIL.upper()),))
        result = cur.fetchone()[0]
    assert result == {}, f"allowlisted email should be allowed ('{{}}'), got {result}"


# ============================================================================
# UNIT — handle_new_user (the AFTER INSERT provisioner)
# ============================================================================
def _membership_count(conn: psycopg.Connection, user_id: uuid.UUID) -> tuple[int, str | None]:
    with conn.cursor() as cur:
        cur.execute(
            "select count(*), max(role) from public.memberships where user_id=%s and org_id=%s",
            (user_id, ORG),
        )
        n, role = cur.fetchone()
    return n, role


def test_handle_new_user_provisions_one_viewer_membership(seeded):
    with seeded.cursor() as cur:
        cur.execute("insert into auth.users (id, email) values (%s,%s)", (PARTNER, PARTNER_EMAIL))
    n, role = _membership_count(seeded, PARTNER)
    assert n == 1, f"expected exactly one membership, got {n}"
    assert role == "viewer", f"expected viewer, got {role}"


def test_handle_new_user_idempotent_on_reprovision(seeded):
    # First login: the trigger provisions one membership.
    with seeded.cursor() as cur:
        cur.execute("insert into auth.users (id, email) values (%s,%s)", (PARTNER, PARTNER_EMAIL))
    assert _membership_count(seeded, PARTNER)[0] == 1
    # Re-running the trigger's exact provisioning insert (what a second login
    # would attempt) is a no-op against the memberships unique index — no dup.
    with seeded.cursor() as cur:
        cur.execute(
            "insert into public.memberships (user_id, org_id, role) values (%s,%s,'viewer') "
            "on conflict do nothing",
            (PARTNER, ORG),
        )
    assert _membership_count(seeded, PARTNER)[0] == 1, "second provision must not duplicate"


# ============================================================================
# INTEGRATION — simulated signup + RLS read boundary
# ============================================================================
def test_non_allowlisted_signup_provisions_nothing(seeded):
    """A stranger's row (were GoTrue's hook bypassed) provisions zero membership —
    zero blast radius — and the hook function rejects them (the real orphan
    guard: GoTrue aborts the insert on that error)."""
    with seeded.cursor() as cur:
        cur.execute("insert into auth.users (id, email) values (%s,%s)", (STRANGER, STRANGER_EMAIL))
    assert _membership_count(seeded, STRANGER)[0] == 0, "stranger must get no membership"
    with seeded.cursor() as cur:
        cur.execute("select public.enforce_allowlist(%s::jsonb)", (_event(STRANGER_EMAIL),))
        assert "error" in cur.fetchone()[0]


def test_provisioned_partner_reads_seed_under_rls(seeded):
    with seeded.cursor() as cur:
        cur.execute("insert into auth.users (id, email) values (%s,%s)", (PARTNER, PARTNER_EMAIL))
    # Act AS the provisioned partner: RLS should let them read the org's seed.
    with as_user(PARTNER) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.metrics where metric_id=%s", (METRIC,))
        assert cur.fetchone()[0] == 1, "provisioned partner should read the seeded metric"


def test_stranger_reads_zero_under_rls(seeded):
    # A user with no membership (never allowlisted) reads nothing in the tenant.
    with seeded.cursor() as cur:
        cur.execute("insert into auth.users (id, email) values (%s,%s)", (STRANGER, STRANGER_EMAIL))
    with as_user(STRANGER) as conn, conn.cursor() as cur:
        cur.execute("select count(*) from public.metrics where metric_id=%s", (METRIC,))
        assert cur.fetchone()[0] == 0, "a non-member must read zero rows (RLS)"
