-- ============================================================================
-- INVITE-ONLY AUTH ALLOWLIST  (issue #5 — design-partner demo launch gate)
-- ============================================================================
-- Google OAuth makes sign-in == sign-up: any Google account that clicks the
-- button gets an auth.users row. "Invite-only" therefore cannot rely on
-- account-existence. One allowed_emails row carries BOTH facts — may-log-in and
-- attach-to-org-as-role — and two mechanisms consume it:
--
--   1. enforce_allowlist(event jsonb)  — the GoTrue **Before User Created** hook.
--      Runs inside GoTrue before the auth.users insert; rejects any email not on
--      the list, so a non-invited Google user never gets a row (no orphan).
--      Registered in supabase/config.toml ([auth.hook.before_user_created]).
--   2. handle_new_user()  — an AFTER INSERT trigger on auth.users. On the first
--      login of an allowlisted user it materializes ONE org-level membership
--      (viewer), idempotent against the memberships unique index.
--
-- The two are complementary: the hook is the gate (no row for strangers), the
-- trigger is the provisioner (invited users land on the seeded org). Everything
-- is additive; see the issue's Rollback section.

-- ============================================================================
-- allowed_emails — the invite list + pre-provision intent, one row per invite
-- ============================================================================

create table public.allowed_emails (
  email       text primary key,                       -- store lowercased (see below)
  org_id      uuid not null references public.orgs(org_id) on delete cascade,
  role        text not null default 'viewer'
                check (role in ('owner','admin','member','viewer')),
  invited_by  uuid references auth.users(id) on delete set null,
  invited_at  timestamptz not null default now()
);
comment on table public.allowed_emails is
  'Invite allowlist for the design-partner demo (issue #5). Emails stored '
  'lowercased; enforce_allowlist + handle_new_user compare lower(email). '
  'Service-role only — inviting is an admin op; RLS is default-deny.';

alter table public.allowed_emails enable row level security;
-- No authenticated policies: RLS default-deny. Invites are a service_role op
-- (the invite CLI / provisioner), never an end-user write.
grant select, insert, update, delete on public.allowed_emails to service_role;

-- ============================================================================
-- enforce_allowlist — Before User Created hook (rejects non-invited signups)
-- ============================================================================
-- Contract VERIFIED against the current Supabase docs (Before User Created
-- Hook): the payload nests the email at event->'user'->>'email' (NOT the
-- 'claims' path the issue's draft guessed). Return '{}'::jsonb to allow; return
-- an {error:{http_code,message}} object to reject — GoTrue aborts the insert and
-- surfaces the message to the client (→ /login?error=not_allowed). security
-- definer + empty search_path so the function reads public.allowed_emails while
-- running as the (limited) supabase_auth_admin caller.
create or replace function public.enforce_allowlist(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(event->'user'->>'email');
begin
  if v_email is null or not exists (
    select 1 from public.allowed_emails a where a.email = v_email
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message',
        'This email is not on the Causent invite list. Ask your Causent contact for access.'
      )
    );
  end if;
  return '{}'::jsonb;  -- allow
end;
$$;

-- GoTrue calls the hook as supabase_auth_admin; that role must be able to run it
-- but nobody else should. (Mirrors the docs' permission block.)
grant execute on function public.enforce_allowlist(jsonb) to supabase_auth_admin;
revoke execute on function public.enforce_allowlist(jsonb) from authenticated, anon, public;

-- ============================================================================
-- handle_new_user — AFTER INSERT provisioner (materialize the membership)
-- ============================================================================
-- Reads the same allowed_emails row and attaches the new user to the shared org
-- at the invited role. Org-level membership (project_id/workspace_id NULL)
-- inherits DOWN via has_scope_grant, so the partner reads the whole seeded
-- hierarchy including workspace ca5e…d3. Idempotent against memberships'
-- unique(user_id, org_id, project_id, workspace_id) — a second login is a
-- no-op. Non-allowlisted or email-less inserts (e.g. the seed's synthetic owner,
-- whose auth.users row has no email) fall through untouched.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.allowed_emails%rowtype;
begin
  if new.email is null then
    return new;
  end if;
  select * into a from public.allowed_emails where email = lower(new.email);
  if found then
    insert into public.memberships (user_id, org_id, role)
    values (new.id, a.org_id, a.role)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
