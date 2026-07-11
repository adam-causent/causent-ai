-- ============================================================================
-- PROSPECTIVE LAYER  (intent + prediction tables — epic #6, child #7)
-- ============================================================================
-- The prospective on-ramp sits UPSTREAM of the ACTION/CLUSTER -> METRIC causal
-- graph (see docs/designs/prospective-prediction-loop.md). Decisions are the
-- intent layer that groups actions and owns predictions; they are NOT
-- nodes/causal_edges participants — the causal layer stays clean.
--
-- Five new tables: decisions, decision_actions, predictions,
-- prediction_revisions, transition_events. transition_events is CREATED here
-- but nothing writes to it until the drift detector lands (Tranche 3).
--
-- RLS mirrors the existing domain-table pattern (viewer reads, member writes,
-- no delete policy — service_role bypasses). Tables without their own scope_id
-- resolve scope through a SECURITY DEFINER resolver, mirroring metric_scope().
-- Every new table gets explicit grants (CI's setup-cli@latest applies no
-- implicit defaults — see 20260709000000_grant_base_privileges.sql).

-- ============================================================================
-- Tables
-- ============================================================================

-- The intent layer: a decision groups the actions that implement it and owns
-- the predictions committed against it.
create table public.decisions (
  decision_id  uuid primary key default gen_random_uuid(),
  scope_id     uuid not null references public.workspaces(workspace_id) on delete cascade,
  title        text not null,
  rationale    jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index decisions_scope_id_idx on public.decisions(scope_id);

-- decision -> many actions; is_lever marks which action carries the mechanism.
-- v1 invariant: ONE lever per (decision, metric) — enforced app-side (capture
-- UI blocks a second lever; the resolution runner raises on duplicates). Not a
-- DB constraint: the invariant spans decision_actions.is_lever and
-- predictions.metric_id, which a unique index cannot reach across.
-- Forward-compat (do NOT build now): a nullable
--   lever_metric_id uuid references public.metrics(metric_id)
-- on this table (NULL = levers all of the decision's predictions, the v1
-- behavior) + a partial unique index (decision_id, lever_metric_id) where
-- is_lever. Documented so nobody designs against is_lever staying a bare
-- boolean. Multiple levers for the SAME metric stays deferred
-- (multi-intervention resolution semantics).
create table public.decision_actions (
  decision_id  uuid not null references public.decisions(decision_id) on delete cascade,
  action_id    uuid not null references public.actions(action_id) on delete cascade,
  is_lever     boolean not null default false,
  primary key (decision_id, action_id)
);

create index decision_actions_action_id_idx on public.decision_actions(action_id);

-- Human pre-registered prediction — distinct from engine-measured
-- evidence_objects. Elicit-not-assert: the human authors this row; the engine
-- only measures it at resolution_date.
--
-- Units (store-both, score-native): magnitude_pct_mean (%-of-metric-mean) is
-- the human commitment and stays authoritative. magnitude_native /
-- native_denom_mean are a convenience snapshot taken at commit time for
-- display/audit only — at resolution the scorer re-derives the native
-- prediction from magnitude_pct_mean and the exact ITS pre-window mean, so
-- both sides of the comparison share one denominator.
create table public.predictions (
  prediction_id       uuid primary key default gen_random_uuid(),
  scope_id            uuid not null references public.workspaces(workspace_id) on delete cascade,
  decision_id         uuid not null references public.decisions(decision_id) on delete cascade,
  metric_id           uuid not null references public.metrics(metric_id) on delete cascade,
  direction           text not null check (direction in ('POSITIVE','NEGATIVE')),
  magnitude_pct_mean  real not null,
  magnitude_native    real,
  native_denom_mean   real,
  resolution_date     date not null,
  committed_by        uuid references auth.users(id) on delete set null,
  committed_at        timestamptz not null default now(),
  resolved_edge_id    uuid references public.causal_edges(edge_id) on delete set null,
  resolved_verdict    text check (resolved_verdict in
    ('CONFIRMED','DIRECTION_CONFIRMED','REFUTED','INCONCLUSIVE',
     'GATHERING','UNRESOLVABLE','VOIDED','UNATTRIBUTED')),
  resolved_at         timestamptz,
  -- The memory tuple written by the resolution runner: predicted/measured
  -- direction + magnitude, ci bounds, belief score/reason, verdict, and the
  -- reference-class features (metric name, action labels, mechanism category).
  -- "The verdict is a cosmetic label; memory lives in the stored tuple" —
  -- consumed by the on-the-fly priors query (lib/priors.ts).
  resolution_tuple    jsonb
);

create index predictions_scope_id_idx on public.predictions(scope_id);
create index predictions_decision_id_idx on public.predictions(decision_id);
create index predictions_metric_id_idx on public.predictions(metric_id);
-- The resolution runner scans for due predictions: unresolved rows AND
-- GATHERING rows (which re-measure; resolved_at stays NULL until terminal).
create index predictions_due_idx on public.predictions(resolution_date)
  where resolved_at is null;

-- Append-only revision log: a revision is data, not a failure ("we predict",
-- revisable with a logged reason).
create table public.prediction_revisions (
  revision_id     uuid primary key default gen_random_uuid(),
  prediction_id   uuid not null references public.predictions(prediction_id) on delete cascade,
  old_magnitude   real,
  old_direction   text,
  new_magnitude   real,
  new_direction   text,
  reason          text not null,
  revised_by      uuid references auth.users(id) on delete set null,
  revised_at      timestamptz not null default now()
);

create index prediction_revisions_prediction_id_idx
  on public.prediction_revisions(prediction_id);

-- Work-item transitions — append-only; drives drift + sets the intervention
-- date. Created in this epic; the write path (webhooks + cron reconciliation)
-- is Tranche 3.
create table public.transition_events (
  event_id          uuid primary key default gen_random_uuid(),
  action_id         uuid not null references public.actions(action_id) on delete cascade,
  from_status       text,
  to_status         text,
  canonical         text not null check (canonical in ('LEVER_DROPPED','LEVER_SHIPPED','LEVER_ACTIVE')),
  source            text not null check (source in ('jira','github')),
  provider_event_id text not null,
  transition_ts     timestamptz not null,
  raw_payload       jsonb,
  unique (source, provider_event_id)
);

create index transition_events_action_id_idx on public.transition_events(action_id);

-- ============================================================================
-- Widen actions.source: +'jira'
-- ============================================================================
-- Resolve the real CHECK constraint name from the catalog rather than guessing
-- the auto-generated name of the inline v1 check.
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.actions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%source%';
  if cname is not null then
    execute format('alter table public.actions drop constraint %I', cname);
  end if;
end $$;

alter table public.actions add constraint actions_source_check
  check (source in ('github_pr','github_issue','jira','manual'));

-- ============================================================================
-- Scope resolvers for tables without their own scope_id
-- ============================================================================
-- Mirror public.metric_scope(): SECURITY DEFINER, self-gated so an
-- inaccessible parent resolves to NULL (default-deny, no id-probing leak).

create function public.decision_scope(t_decision uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select d.scope_id from public.decisions d
  where d.decision_id = t_decision
    and public.has_scope_access(d.scope_id, 'viewer');
$$;

create function public.prediction_scope(t_prediction uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select p.scope_id from public.predictions p
  where p.prediction_id = t_prediction
    and public.has_scope_access(p.scope_id, 'viewer');
$$;

create function public.action_scope(t_action uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select a.scope_id from public.actions a
  where a.action_id = t_action
    and public.has_scope_access(a.scope_id, 'viewer');
$$;

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.decisions enable row level security;
alter table public.decision_actions enable row level security;
alter table public.predictions enable row level security;
alter table public.prediction_revisions enable row level security;
alter table public.transition_events enable row level security;

-- --- decisions (direct scope_id; mirrors actions) ---------------------------
create policy decisions_select on public.decisions for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy decisions_insert on public.decisions for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy decisions_update on public.decisions for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));
-- No delete policy: default-deny (service_role bypasses RLS).

-- --- decision_actions (scope via BOTH parents) ------------------------------
-- Insert/update require member access to the decision's scope AND the
-- action's scope, so a member of scope A cannot link scope B's action into
-- their decision (or vice versa).
create policy decision_actions_select on public.decision_actions for select to authenticated
  using (public.has_scope_access(public.decision_scope(decision_id), 'viewer'));
create policy decision_actions_insert on public.decision_actions for insert to authenticated
  with check (
    public.has_scope_access(public.decision_scope(decision_id), 'member')
    and public.has_scope_access(public.action_scope(action_id), 'member')
  );
create policy decision_actions_update on public.decision_actions for update to authenticated
  using (public.has_scope_access(public.decision_scope(decision_id), 'member'))
  with check (
    public.has_scope_access(public.decision_scope(decision_id), 'member')
    and public.has_scope_access(public.action_scope(action_id), 'member')
  );

-- --- predictions (direct scope_id) ------------------------------------------
create policy predictions_select on public.predictions for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy predictions_insert on public.predictions for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy predictions_update on public.predictions for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));

-- --- prediction_revisions (scope via prediction; append-only) ---------------
create policy prediction_revisions_select on public.prediction_revisions for select to authenticated
  using (public.has_scope_access(public.prediction_scope(prediction_id), 'viewer'));
create policy prediction_revisions_insert on public.prediction_revisions for insert to authenticated
  with check (public.has_scope_access(public.prediction_scope(prediction_id), 'member'));
-- No update/delete policies: the revision log is append-only (mirrors
-- evidence_objects; privilege-level guard below).

-- --- transition_events (scope via action; append-only; Tranche-3 writes) ----
create policy transition_events_select on public.transition_events for select to authenticated
  using (public.has_scope_access(public.action_scope(action_id), 'viewer'));
create policy transition_events_insert on public.transition_events for insert to authenticated
  with check (public.has_scope_access(public.action_scope(action_id), 'member'));
-- No update/delete policies: append-only event log.

-- ============================================================================
-- Table-level grants
-- ============================================================================
-- The blanket grants in 20260709000000_grant_base_privileges.sql only covered
-- tables that existed then — every new table must grant explicitly.

grant select, insert, update, delete on public.decisions to authenticated, service_role;
grant select on public.decisions to anon;

grant select, insert, update, delete on public.decision_actions to authenticated, service_role;
grant select on public.decision_actions to anon;

grant select, insert, update, delete on public.predictions to authenticated, service_role;
grant select on public.predictions to anon;

grant select, insert, update, delete on public.prediction_revisions to authenticated, service_role;
grant select on public.prediction_revisions to anon;

grant select, insert, update, delete on public.transition_events to authenticated, service_role;
grant select on public.transition_events to anon;

-- Append-only guards at the privilege layer (mirrors evidence_objects):
-- revoke AFTER the blanket grants above.
revoke update, delete, truncate on public.prediction_revisions from authenticated, anon;
revoke update, delete, truncate on public.transition_events from authenticated, anon;
