-- Activated reports can leave visible workspace history without erasing the
-- canonical decision graph they produced. Replacing only this checked RPC
-- preserves the initial conservative migration while widening the user-facing
-- removal contract after validating legacy-fallback isolation.

create or replace function public.delete_decision_report_v1(
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

revoke all on function public.delete_decision_report_v1(uuid, uuid) from public;
grant execute on function public.delete_decision_report_v1(uuid, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
