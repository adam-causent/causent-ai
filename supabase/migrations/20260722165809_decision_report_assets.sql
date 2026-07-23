-- Decision Report Slice 8: one sanitized private PNG/JPEG per editable report.
-- Storage bytes are managed only through the Storage API. This migration owns
-- the private bucket, scope-bound metadata, checked lifecycle RPCs, and RLS.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'decision-report-assets',
  'decision-report-assets',
  false,
  5242880,
  array['image/png', 'image/jpeg']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.report_assets (
  asset_id             uuid primary key default gen_random_uuid(),
  report_id            uuid not null,
  scope_id             uuid not null,
  reserved_revision_id uuid not null,
  attached_revision_id uuid,
  bucket_id            text not null default 'decision-report-assets'
    check (bucket_id = 'decision-report-assets'),
  object_path          text not null unique check (
    object_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}[.](png|jpg)$'
  ),
  media_type           text check (media_type in ('image/png', 'image/jpeg')),
  byte_size            integer check (byte_size between 1 and 5242880),
  width                 integer check (width between 1 and 4096),
  height                integer check (height between 1 and 4096),
  content_hash          text check (content_hash ~ '^[0-9a-f]{64}$'),
  status                text not null default 'pending'
    check (status in ('pending', 'attached', 'detached')),
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (report_id, scope_id)
    references public.decision_reports(report_id, scope_id) on delete cascade,
  foreign key (report_id, reserved_revision_id)
    references public.decision_report_revisions(report_id, revision_id),
  foreign key (report_id, attached_revision_id)
    references public.decision_report_revisions(report_id, revision_id)
);

create index report_assets_scope_report_idx
  on public.report_assets(scope_id, report_id, status);

alter table public.report_assets enable row level security;

create function private.assert_decision_report_revision_assets()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids jsonb := coalesce(new.snapshot #> '{implementation,assetIds}', '[]'::jsonb);
begin
  if jsonb_typeof(v_ids) <> 'array' or jsonb_array_length(v_ids) > 1 then
    raise exception 'A Decision Report may contain at most one supplied image.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_ids) = 1 and not exists (
    select 1 from public.report_assets a
    where a.asset_id::text = v_ids->>0 and a.report_id = new.report_id
      and a.scope_id = new.scope_id and a.status = 'attached'
  ) then
    raise exception 'The supplied image is not attached to this report.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger decision_report_revision_assets_guard
before insert on public.decision_report_revisions
for each row execute function private.assert_decision_report_revision_assets();

create policy report_assets_select
  on public.report_assets for select to authenticated
  using (public.has_scope_access(scope_id, 'member'));

revoke all on public.report_assets from anon, authenticated;
grant select on public.report_assets to authenticated, service_role;

create function public.reserve_decision_report_asset_v1(
  p_report_id uuid,
  p_base_revision_id uuid,
  p_extension text,
  p_authored_by uuid
)
returns table (asset_id uuid, object_path text, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.decision_reports%rowtype;
  v_asset public.report_assets%rowtype;
  v_asset_id uuid := gen_random_uuid();
  v_extension text;
begin
  select * into v_report from public.decision_reports
  where decision_reports.report_id = p_report_id for update;
  if not found then
    raise exception 'Report not found or unavailable.' using errcode = '42501';
  end if;
  perform private.assert_decision_report_write(v_report.scope_id, p_authored_by);
  if v_report.status = 'active' then
    raise exception 'REPORT_ALREADY_ACTIVE' using errcode = '40001';
  end if;
  if v_report.current_revision_id is distinct from p_base_revision_id then
    raise exception 'STALE_REVISION' using errcode = '40001', detail = v_report.current_revision_id::text;
  end if;
  if p_extension not in ('png', 'jpg') then
    raise exception 'Invalid image format.' using errcode = '22023';
  end if;
  v_extension := p_extension;

  select * into v_asset from public.report_assets
  where report_assets.report_id = p_report_id
    and report_assets.reserved_revision_id = p_base_revision_id
    and report_assets.object_path like '%.' || p_extension
    and report_assets.status = 'pending'
  order by report_assets.created_at desc limit 1;
  if found then
    return query select v_asset.asset_id, v_asset.object_path, true;
    return;
  end if;

  insert into public.report_assets (
    asset_id, report_id, scope_id, reserved_revision_id, object_path, created_by
  ) values (
    v_asset_id, v_report.report_id, v_report.scope_id, p_base_revision_id,
    v_report.scope_id::text || '/' || v_report.report_id::text || '/' ||
      v_asset_id::text || '.' || v_extension,
    p_authored_by
  ) returning * into v_asset;
  return query select v_asset.asset_id, v_asset.object_path, false;
end;
$$;

create function public.attach_decision_report_asset_v1(
  p_asset_id uuid,
  p_report_id uuid,
  p_base_revision_id uuid,
  p_title text,
  p_status text,
  p_snapshot jsonb,
  p_metric_projection jsonb,
  p_media_type text,
  p_byte_size integer,
  p_width integer,
  p_height integer,
  p_content_hash text,
  p_authored_by uuid
)
returns table (report_id uuid, revision_id uuid, status text, saved_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.decision_reports%rowtype;
  v_asset public.report_assets%rowtype;
  v_saved record;
begin
  select * into v_report from public.decision_reports
  where decision_reports.report_id = p_report_id for update;
  if not found then raise exception 'Report not found or unavailable.' using errcode = '42501'; end if;
  perform private.assert_decision_report_write(v_report.scope_id, p_authored_by);
  if v_report.status = 'active' then raise exception 'REPORT_ALREADY_ACTIVE' using errcode = '40001'; end if;
  if v_report.current_revision_id is distinct from p_base_revision_id then
    raise exception 'STALE_REVISION' using errcode = '40001', detail = v_report.current_revision_id::text;
  end if;
  select * into v_asset from public.report_assets
  where asset_id = p_asset_id and report_assets.report_id = p_report_id
    and scope_id = v_report.scope_id and reserved_revision_id = p_base_revision_id
    and report_assets.status = 'pending' for update;
  if not found then raise exception 'Asset not found or unavailable.' using errcode = '42501'; end if;
  if jsonb_array_length(coalesce(p_snapshot #> '{implementation,assetIds}', '[]'::jsonb)) <> 1
     or p_snapshot #>> '{implementation,assetIds,0}' <> p_asset_id::text then
    raise exception 'The report snapshot must attach exactly the reserved asset.' using errcode = '22023';
  end if;
  if p_media_type not in ('image/png', 'image/jpeg') or p_byte_size not between 1 and 5242880
     or p_width not between 1 and 4096 or p_height not between 1 and 4096
     or (p_width::bigint * p_height::bigint) > 16000000
     or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid sanitized image metadata.' using errcode = '22023';
  end if;

  update public.report_assets
  set status = 'detached', updated_at = now()
  where report_assets.report_id = p_report_id and report_assets.status = 'attached';
  update public.report_assets
  set status = 'attached',
      media_type = p_media_type, byte_size = p_byte_size, width = p_width,
      height = p_height, content_hash = p_content_hash, updated_at = now()
  where asset_id = p_asset_id;
  select * into v_saved from public.append_decision_report_revision_v1(
    p_report_id, p_base_revision_id, p_title, p_status,
    p_snapshot, p_metric_projection, p_authored_by
  );
  update public.report_assets
  set attached_revision_id = v_saved.revision_id, updated_at = now()
  where asset_id = p_asset_id;
  return query select p_report_id, v_saved.revision_id, v_saved.status, v_saved.saved_at;
end;
$$;

create function public.detach_decision_report_asset_v1(
  p_asset_id uuid,
  p_report_id uuid,
  p_base_revision_id uuid,
  p_title text,
  p_status text,
  p_snapshot jsonb,
  p_metric_projection jsonb,
  p_authored_by uuid
)
returns table (report_id uuid, revision_id uuid, status text, saved_at timestamptz, object_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.decision_reports%rowtype;
  v_asset public.report_assets%rowtype;
  v_saved record;
begin
  select * into v_report from public.decision_reports
  where decision_reports.report_id = p_report_id for update;
  if not found then raise exception 'Report not found or unavailable.' using errcode = '42501'; end if;
  perform private.assert_decision_report_write(v_report.scope_id, p_authored_by);
  if v_report.status = 'active' then raise exception 'REPORT_ALREADY_ACTIVE' using errcode = '40001'; end if;
  if v_report.current_revision_id is distinct from p_base_revision_id then
    raise exception 'STALE_REVISION' using errcode = '40001', detail = v_report.current_revision_id::text;
  end if;
  select * into v_asset from public.report_assets
  where asset_id = p_asset_id and report_assets.report_id = p_report_id
    and scope_id = v_report.scope_id and report_assets.status = 'attached' for update;
  if not found then raise exception 'Asset not found or unavailable.' using errcode = '42501'; end if;
  if jsonb_array_length(coalesce(p_snapshot #> '{implementation,assetIds}', '[]'::jsonb)) <> 0 then
    raise exception 'The report snapshot must detach the supplied asset.' using errcode = '22023';
  end if;
  update public.report_assets set status = 'detached', updated_at = now()
  where asset_id = p_asset_id;
  select * into v_saved from public.append_decision_report_revision_v1(
    p_report_id, p_base_revision_id, p_title, p_status,
    p_snapshot, p_metric_projection, p_authored_by
  );
  return query select p_report_id, v_saved.revision_id, v_saved.status, v_saved.saved_at, v_asset.object_path;
end;
$$;

create function public.abandon_decision_report_asset_v1(p_asset_id uuid, p_authored_by uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_asset public.report_assets%rowtype;
begin
  select * into v_asset from public.report_assets where asset_id = p_asset_id for update;
  if not found then return true; end if;
  perform private.assert_decision_report_write(v_asset.scope_id, p_authored_by);
  if v_asset.status = 'attached' then
    raise exception 'Attached assets must be detached first.' using errcode = '42501';
  end if;
  delete from public.report_assets where asset_id = p_asset_id;
  return true;
end;
$$;

create policy decision_report_asset_objects_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'decision-report-assets'
    and exists (
      select 1 from public.report_assets a
      where a.object_path = name and a.status = 'pending'
        and public.has_scope_access(a.scope_id, 'member')
    )
  );
create policy decision_report_asset_objects_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'decision-report-assets'
    and exists (
      select 1 from public.report_assets a
      where a.object_path = name and a.status = 'attached'
        and public.has_scope_access(a.scope_id, 'member')
    )
  );
create policy decision_report_asset_objects_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'decision-report-assets'
    and exists (
      select 1 from public.report_assets a
      where a.object_path = name and a.status in ('pending', 'detached')
        and public.has_scope_access(a.scope_id, 'member')
    )
  );

revoke all on function public.reserve_decision_report_asset_v1(uuid, uuid, text, uuid) from public;
revoke all on function public.attach_decision_report_asset_v1(uuid, uuid, uuid, text, text, jsonb, jsonb, text, integer, integer, integer, text, uuid) from public;
revoke all on function public.detach_decision_report_asset_v1(uuid, uuid, uuid, text, text, jsonb, jsonb, uuid) from public;
revoke all on function public.abandon_decision_report_asset_v1(uuid, uuid) from public;
revoke all on function private.assert_decision_report_revision_assets() from public;
grant execute on function public.reserve_decision_report_asset_v1(uuid, uuid, text, uuid) to authenticated, service_role;
grant execute on function public.attach_decision_report_asset_v1(uuid, uuid, uuid, text, text, jsonb, jsonb, text, integer, integer, integer, text, uuid) to authenticated, service_role;
grant execute on function public.detach_decision_report_asset_v1(uuid, uuid, uuid, text, text, jsonb, jsonb, uuid) to authenticated, service_role;
grant execute on function public.abandon_decision_report_asset_v1(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
