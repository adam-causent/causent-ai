-- Decision Report history removal.
--
-- Reports that have not been activated may be removed from the workspace
-- history without destroying their append-only revisions or supplied assets.
-- Activated reports remain immutable because their canonical decision,
-- prediction, and actions are audit history. Application roles still have no
-- direct table writes; the checked RPC below is the only removal path.

alter table public.decision_reports
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id) on delete set null;

alter table public.decision_reports
  add constraint decision_reports_deletion_state_check check (
    (deleted_at is null and deleted_by is null)
    or deleted_at is not null
  );

create index decision_reports_scope_live_updated_idx
  on public.decision_reports(scope_id, updated_at desc)
  where deleted_at is null;

-- Once removed, a report cannot be edited or activated through an older RPC.
-- An identical delete retry is handled before UPDATE by the delete RPC.
create function private.prevent_deleted_decision_report_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'REPORT_DELETED' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger decision_reports_prevent_update_after_delete
before update on public.decision_reports
for each row execute function private.prevent_deleted_decision_report_update();

-- Defense in depth for the append-only revision RPC, which predates soft
-- deletion and otherwise only knows about the active lifecycle state.
create function private.prevent_deleted_decision_report_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.decision_reports as report
    where report.report_id = new.report_id
      and report.deleted_at is not null
  ) then
    raise exception 'REPORT_DELETED' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger decision_report_revisions_prevent_insert_after_delete
before insert on public.decision_report_revisions
for each row execute function private.prevent_deleted_decision_report_revision();

-- A removed report also cannot reserve or attach new supplied-image metadata.
-- DELETE remains available to service cleanup paths.
create function private.prevent_deleted_decision_report_asset_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.decision_reports as report
    where report.report_id = new.report_id
      and report.deleted_at is not null
  ) then
    raise exception 'REPORT_DELETED' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger report_assets_prevent_write_after_report_delete
before insert or update on public.report_assets
for each row execute function private.prevent_deleted_decision_report_asset_write();

create function public.delete_decision_report_v1(
  p_report_id uuid,
  p_authored_by uuid
)
returns table (
  report_id uuid,
  deleted_at timestamptz,
  reused boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.decision_reports%rowtype;
  v_deleted_at timestamptz := now();
begin
  select * into v_report
  from public.decision_reports
  where decision_reports.report_id = p_report_id
  for update;

  if not found then
    raise exception 'Report not found or unavailable.' using errcode = '42501';
  end if;

  perform private.assert_decision_report_write(v_report.scope_id, p_authored_by);

  if v_report.status = 'active' then
    raise exception 'ACTIVE_REPORT_DELETE_FORBIDDEN' using errcode = 'PT409';
  end if;

  if v_report.deleted_at is not null then
    return query select v_report.report_id, v_report.deleted_at, true;
    return;
  end if;

  update public.decision_reports
  set deleted_at = v_deleted_at,
      deleted_by = p_authored_by
  where decision_reports.report_id = v_report.report_id;

  return query select v_report.report_id, v_deleted_at, false;
end;
$$;

drop policy decision_reports_select on public.decision_reports;
create policy decision_reports_select
  on public.decision_reports
  for select
  to authenticated
  using (
    deleted_at is null
    and public.has_scope_access(scope_id, 'viewer')
  );

drop policy decision_report_revisions_select on public.decision_report_revisions;
create policy decision_report_revisions_select
  on public.decision_report_revisions
  for select
  to authenticated
  using (
    public.has_scope_access(scope_id, 'viewer')
    and exists (
      select 1
      from public.decision_reports as report
      where report.report_id = decision_report_revisions.report_id
        and report.deleted_at is null
    )
  );

drop policy report_assets_select on public.report_assets;
create policy report_assets_select
  on public.report_assets
  for select
  to authenticated
  using (
    public.has_scope_access(scope_id, 'member')
    and exists (
      select 1
      from public.decision_reports as report
      where report.report_id = report_assets.report_id
        and report.deleted_at is null
    )
  );

revoke all on function public.delete_decision_report_v1(uuid, uuid) from public;
grant execute on function public.delete_decision_report_v1(uuid, uuid)
  to authenticated, service_role;

revoke all on function private.prevent_deleted_decision_report_update() from public;
revoke all on function private.prevent_deleted_decision_report_revision() from public;
revoke all on function private.prevent_deleted_decision_report_asset_write() from public;

notify pgrst, 'reload schema';
