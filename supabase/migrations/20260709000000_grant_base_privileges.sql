-- Base table privileges for the Supabase auth roles (anon, authenticated,
-- service_role).
--
-- Row-level security (20260703223628_v1_rls.sql) is the ROW gate, but Postgres
-- also requires table-level GRANTs before RLS is even consulted. The original
-- schema relied on Supabase's IMPLICIT default privileges to grant anon +
-- authenticated on new public tables. That holds under the pinned local CLI but
-- NOT under `supabase/setup-cli@latest` in CI, where the user-migration tables
-- land without those grants and every RLS/bridge test dies at the privilege
-- layer with "permission denied for table ..." (green locally, red in CI).
--
-- Grant explicitly so the schema is self-contained and version-independent. RLS
-- still does ALL row filtering; these grants only open the coarse privilege gate.
-- (Later migrations that add tables must grant them too.)

grant usage on schema public to anon, authenticated, service_role;

-- authenticated: full DML — the RLS policies in v1_rls.sql decide which rows and
-- operations actually pass. Without the grant, RLS is never even reached.
grant select, insert, update, delete on all tables in schema public to authenticated;

-- anon: read-only. No RLS policy targets the anon role, so anon still sees zero
-- rows (test_anon_sees_no_rows); this just lets the query run and return 0
-- instead of erroring at the privilege layer.
grant select on all tables in schema public to anon;

-- service_role bypasses RLS (the server-side bridge + the app service client):
-- full DML so those paths keep working on a fresh, default-privilege-free stack.
grant select, insert, update, delete on all tables in schema public to service_role;

-- evidence_objects is append-only: re-assert the privilege-level guard AFTER the
-- blanket grants above (which would otherwise re-grant update/delete on it).
-- Mirrors the revoke in v1_rls.sql so append-only holds even if a policy were
-- later added. anon/authenticated may read + insert evidence, never mutate it.
revoke update, delete, truncate on public.evidence_objects from authenticated, anon;
