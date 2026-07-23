-- Direct workspace core-metric selection.
--
-- Selection is independent from Decision Report activation: a member can add
-- an imported/connected daily metric to the shared Core Metrics surface without
-- being redirected into onboarding. An active report remains the project
-- boundary for report-owned actions and impact data.

alter table public.metrics
  add column if not exists is_core boolean not null default false;

create index if not exists metrics_scope_is_core_idx
  on public.metrics(scope_id, is_core);

create or replace function public.set_workspace_core_metric_v1(
  p_scope_id uuid,
  p_metric_id uuid,
  p_is_core boolean,
  p_authored_by uuid
)
returns table (
  selected_metric_id uuid,
  is_core boolean,
  core_metric_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_metric public.metrics%rowtype;
  v_core_count integer;
begin
  if p_scope_id is null or p_metric_id is null or p_is_core is null then
    raise exception 'The workspace metric selection is invalid.' using errcode = '22023';
  end if;

  -- Serializes the five-metric cap and same-workspace updates.
  perform 1
  from public.workspaces
  where workspaces.workspace_id = p_scope_id
  for update;
  if not found then
    raise exception 'The workspace is unavailable.' using errcode = '42501';
  end if;
  perform private.assert_decision_report_write(p_scope_id, p_authored_by);

  select m.* into v_metric
  from public.metrics as m
  where m.metric_id = p_metric_id
    and m.scope_id = p_scope_id
  for update;
  if not found then
    raise exception 'The metric is unavailable in this workspace.' using errcode = '42501';
  end if;
  if v_metric.granularity <> 'daily' then
    raise exception 'Only daily metrics can be core metrics.' using errcode = '22023';
  end if;

  select count(*)::integer
  into v_core_count
  from public.metrics as m
  where m.scope_id = p_scope_id
    and m.is_core;

  if p_is_core and not v_metric.is_core and v_core_count >= 5 then
    raise exception 'Choose up to 5 core metrics.' using errcode = '22023';
  end if;

  update public.metrics
  set is_core = p_is_core
  where metrics.metric_id = p_metric_id
    and metrics.scope_id = p_scope_id;

  select count(*)::integer
  into v_core_count
  from public.metrics as m
  where m.scope_id = p_scope_id
    and m.is_core;

  return query select p_metric_id, p_is_core, v_core_count;
end;
$$;

revoke all on function public.set_workspace_core_metric_v1(uuid, uuid, boolean, uuid)
  from public, anon;
grant execute on function public.set_workspace_core_metric_v1(uuid, uuid, boolean, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
