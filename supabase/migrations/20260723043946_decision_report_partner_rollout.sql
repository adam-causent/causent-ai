-- Decision Report Slice 9: operator-controlled partner rollout.
--
-- Assignments are per authenticated user inside a workspace because the current
-- design-partner deployment intentionally shares one seeded workspace. The app
-- can read only the caller's own assignment. Mutations remain operator-only via
-- the service role / direct SQL so a partner cannot enroll themselves.

create table public.decision_report_rollouts (
  scope_id uuid not null references public.workspaces(workspace_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  rollout_note text,
  updated_at timestamptz not null default now(),
  primary key (scope_id, user_id),
  constraint decision_report_rollouts_note_length
    check (rollout_note is null or char_length(rollout_note) <= 500)
);

alter table public.decision_report_rollouts enable row level security;

create policy decision_report_rollouts_select_own
  on public.decision_report_rollouts
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_scope_access(scope_id, 'viewer')
  );

revoke all on table public.decision_report_rollouts from public, anon, authenticated;
grant select on table public.decision_report_rollouts to authenticated;
grant select, insert, update, delete on table public.decision_report_rollouts to service_role;

comment on table public.decision_report_rollouts is
  'Operator-managed per-user gate for new Decision Report onboarding starts.';
