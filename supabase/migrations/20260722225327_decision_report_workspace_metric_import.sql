-- Workspace-level CSV metric creation/import.
--
-- The active-report importer intentionally only updates the metric already
-- confirmed by a report. This companion RPC creates (or reuses) a daily CSV
-- metric before report activation, so the new metric can appear in the
-- workspace catalog and be selected during the activation handoff.

create or replace function public.import_workspace_metric_csv_v1(
  p_scope_id uuid,
  p_name text,
  p_unit text,
  p_observations jsonb,
  p_authored_by uuid
)
returns table (
  metric_id uuid,
  metric_name text,
  metric_unit text,
  created boolean,
  accepted_rows integer,
  inserted_rows integer,
  updated_rows integer,
  start_date date,
  end_date date
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_metric public.metrics%rowtype;
  v_item jsonb;
  v_name text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_unit text := nullif(pg_catalog.btrim(coalesce(p_unit, '')), '');
  v_count integer;
  v_existing integer;
  v_start date;
  v_end date;
  v_created boolean := false;
begin
  if p_scope_id is null or v_name = '' or pg_catalog.length(v_name) > 120 then
    raise exception 'Enter a metric name between 1 and 120 characters.' using errcode = '22023';
  end if;
  if v_name ~ '[[:cntrl:]]' then
    raise exception 'Metric names cannot contain control characters.' using errcode = '22023';
  end if;
  if v_unit is null or v_unit not in ('count', 'percent', 'USD') then
    raise exception 'Choose a supported metric unit: count, percent, or USD.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_observations) <> 'array' then
    raise exception 'Observations must be a JSON array.' using errcode = '22023';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_observations);
  if v_count not between 1 and 10000 then
    raise exception 'Import one to 10,000 daily observations.' using errcode = '22023';
  end if;

  -- Lock the workspace row to serialize same-name creation/imports without
  -- trusting a client-provided metric id or relying on a race-prone read/insert.
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
  where m.scope_id = p_scope_id
    and pg_catalog.lower(pg_catalog.btrim(m.name)) = pg_catalog.lower(v_name)
  order by m.metric_id
  limit 1
  for update;

  if not found then
    insert into public.metrics (scope_id, name, source, granularity, unit)
    values (p_scope_id, v_name, 'csv', 'daily', v_unit)
    returning * into v_metric;
    v_created := true;
  else
    if v_metric.source = 'connector' then
      raise exception 'This metric is managed by a connector. Choose another name.' using errcode = '22023';
    end if;
    if v_metric.granularity <> 'daily' then
      raise exception 'Only daily metrics can accept this CSV. Choose another metric.' using errcode = '22023';
    end if;
    if v_metric.unit is not null and v_metric.unit <> v_unit then
      raise exception 'This metric already uses the % unit.', v_metric.unit using errcode = '22023', detail = v_metric.unit;
    end if;
    if v_metric.unit is null then
      update public.metrics set unit = v_unit where metrics.metric_id = v_metric.metric_id;
      v_metric.unit := v_unit;
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_observations)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or (v_item - array['date', 'value']::text[]) <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(v_item->'date') <> 'string'
       or pg_catalog.jsonb_typeof(v_item->'value') <> 'number'
       or (v_item->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Every observation must contain only a YYYY-MM-DD date and finite numeric value.' using errcode = '22023';
    end if;
  end loop;

  if (
    select count(distinct observation.date_value)
    from (
      select (item->>'date')::date as date_value
      from jsonb_array_elements(p_observations) as items(item)
    ) observation
  ) <> v_count then
    raise exception 'Each daily date must appear exactly once.' using errcode = '22023';
  end if;

  select min(observation.date_value), max(observation.date_value)
  into v_start, v_end
  from (
    select (item->>'date')::date as date_value
    from jsonb_array_elements(p_observations) as items(item)
  ) observation;

  select count(*) into v_existing
  from public.metric_observations
  where metric_observations.metric_id = v_metric.metric_id
    and metric_observations.obs_date in (
      select (item->>'date')::date
      from jsonb_array_elements(p_observations) as items(item)
    );

  insert into public.metric_observations (metric_id, obs_date, value)
  select v_metric.metric_id, (item->>'date')::date, (item->>'value')::numeric
  from jsonb_array_elements(p_observations) as items(item)
  on conflict on constraint metric_observations_pkey do update
    set value = excluded.value;

  update public.metrics
  set source = 'csv'
  where metrics.metric_id = v_metric.metric_id;

  return query select
    v_metric.metric_id,
    v_metric.name,
    coalesce(v_metric.unit, v_unit),
    v_created,
    v_count,
    v_count - v_existing,
    v_existing,
    v_start,
    v_end;
end;
$$;

revoke all on function public.import_workspace_metric_csv_v1(uuid, text, text, jsonb, uuid)
  from public, anon;
grant execute on function public.import_workspace_metric_csv_v1(uuid, text, text, jsonb, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
