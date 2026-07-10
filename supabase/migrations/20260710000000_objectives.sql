-- ============================================================================
-- OBJECTIVES  (the project north-star document)
-- ============================================================================
-- One purpose statement per workspace: the "why" every shipped action rolls up
-- to, rendered above the Actions & Decisions list (ObjectivePanel) and in
-- stakeholder reports. Scoped like every other domain table: scope_id ->
-- workspaces (the operating level), RLS via has_scope_access().

create table public.objectives (
  objective_id  uuid primary key default gen_random_uuid(),
  scope_id      uuid not null references public.workspaces(workspace_id) on delete cascade,
  -- Short eyebrow label rendered above the statement, e.g. "North Star".
  title         text not null default 'North Star',
  -- The purpose statement — one or two sentences.
  statement     text not null,
  -- Measurable results that define success: a jsonb array of strings.
  key_results   jsonb not null default '[]'::jsonb check (jsonb_typeof(key_results) = 'array'),
  -- Date of last edit (surfaced as "Updated <date>" in the UI).
  updated_at    date not null default current_date
);

-- v1: a single north-star document per workspace.
create unique index objectives_scope_id_key on public.objectives(scope_id);

-- --- RLS (mirrors the metrics policies: viewer reads, member writes) --------
alter table public.objectives enable row level security;

create policy objectives_select on public.objectives for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy objectives_insert on public.objectives for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy objectives_update on public.objectives for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));
-- No delete policy: default-deny (matches metrics; service_role bypasses RLS).

-- --- Table-level grants ------------------------------------------------------
-- The blanket grants in 20260709000000_grant_base_privileges.sql only covered
-- tables that existed then — per that migration's note, every new table must
-- grant explicitly (CI's setup-cli@latest applies no implicit defaults).
grant select, insert, update, delete on public.objectives to authenticated, service_role;
grant select on public.objectives to anon;
