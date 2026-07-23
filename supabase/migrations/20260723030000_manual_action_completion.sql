-- Checked manual completion for Decision Report actions.
--
-- Connector-backed actions continue to be completed by provider events. This
-- path is intentionally limited to planned manual actions materialized from a
-- Decision Report and records the human's date and explanation on the action.

create or replace function public.complete_manual_action_v1(
  p_scope_id uuid,
  p_action_id uuid,
  p_completed_on date,
  p_explanation text,
  p_authored_by uuid
)
returns table (
  completed_action_id uuid,
  completed_on date,
  explanation text,
  reused boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action public.actions%rowtype;
  v_explanation text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_explanation, ''), '\s+', ' ', 'g'));
  v_existing_explanation text;
begin
  if p_scope_id is null or p_action_id is null or p_completed_on is null then
    raise exception 'Choose an action and completion date.' using errcode = '22023';
  end if;
  if p_completed_on > current_date then
    raise exception 'The completion date cannot be in the future.' using errcode = '22023';
  end if;
  if v_explanation = '' or pg_catalog.length(v_explanation) > 1000 or v_explanation ~ '[[:cntrl:]]' then
    raise exception 'Enter a completion explanation between 1 and 1000 characters.' using errcode = '22023';
  end if;

  perform 1
  from public.workspaces
  where workspaces.workspace_id = p_scope_id
  for update;
  if not found then
    raise exception 'The workspace is unavailable.' using errcode = '42501';
  end if;
  perform private.assert_decision_report_write(p_scope_id, p_authored_by);

  select a.* into v_action
  from public.actions as a
  where a.action_id = p_action_id
    and a.scope_id = p_scope_id
  for update;
  if not found then
    raise exception 'The action is unavailable in this workspace.' using errcode = '42501';
  end if;
  if v_action.source <> 'manual'
     or coalesce(v_action.rationale_richtext #>> '{meta,source}', '') <> 'decision_report' then
    raise exception 'Only planned Decision Report actions can be completed manually.' using errcode = '22023';
  end if;

  v_existing_explanation := v_action.rationale_richtext #>> '{meta,manual_completion,explanation}';
  if v_action.effective_date is not null then
    if v_action.effective_date = p_completed_on
       and v_existing_explanation = v_explanation then
      return query select p_action_id, p_completed_on, v_explanation, true;
      return;
    end if;
    raise exception 'This action is already complete.' using errcode = '22023';
  end if;

  update public.actions
  set effective_date = p_completed_on,
      ship_ts = (p_completed_on::timestamp at time zone 'UTC'),
      status = 'complete',
      rationale_richtext = coalesce(rationale_richtext, '{"type":"doc","content":[],"meta":{}}'::jsonb)
        || jsonb_build_object(
          'meta',
          coalesce(rationale_richtext->'meta', '{}'::jsonb)
            || jsonb_build_object(
              'manual_completion', jsonb_build_object(
                'completed_on', p_completed_on,
                'explanation', v_explanation,
                'completed_by', p_authored_by,
                'recorded_at', pg_catalog.clock_timestamp()
              )
            )
        )
  where actions.action_id = p_action_id
    and actions.scope_id = p_scope_id;

  return query select p_action_id, p_completed_on, v_explanation, false;
end;
$$;

revoke all on function public.complete_manual_action_v1(uuid, uuid, date, text, uuid)
  from public, anon;
grant execute on function public.complete_manual_action_v1(uuid, uuid, date, text, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
