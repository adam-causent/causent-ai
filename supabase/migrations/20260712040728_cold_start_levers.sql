-- ============================================================================
-- COLD-START SCHEMA  (epic #13, child C1 / #14)
-- ============================================================================
-- The create-from-decision flow needs a `levers` table holding the
-- draft -> detect lifecycle, supporting multiple levers per decision —
-- including several on the SAME metric (resolved via the cluster overlay in
-- C4, not multi-breakpoint ITS). Three deltas ride along:
--   1. decision_actions.is_lever is dropped — an action is a lever iff it has
--      a levers row (derivable, so the boolean is redundant and can drift).
--   2. metrics.source gains 'declared' — the onboarding funnel creates a
--      name-only metric (no observations) so predictions.metric_id (NOT NULL)
--      is satisfiable before any connector exists. Honest + queryable.
--   3. predictions.resolved_verdict gains 'UNMEASURABLE_NO_METRIC' — the
--      resolution state when a declared metric has no observations at
--      resolution_date.
-- This supersedes the Foundations one-lever-per-(decision,metric) invariant
-- (see 20260711000000_prospective_layer.sql's forward-compat note).

-- ============================================================================
-- levers
-- ============================================================================

create table public.levers (
  lever_id         uuid primary key default gen_random_uuid(),
  scope_id         uuid not null references public.workspaces(workspace_id) on delete cascade,
  decision_id      uuid not null references public.decisions(decision_id) on delete cascade,
  action_id        uuid not null references public.actions(action_id) on delete cascade,
  metric_id        uuid not null references public.metrics(metric_id) on delete cascade,
  provenance_token text not null,
  target_source    text not null check (target_source in ('jira','github')),
  target_ref       text,                        -- repo (owner/name) or Jira project key
  status           text not null default 'DRAFTED'
                     check (status in ('DRAFTED','CREATED','DETECTED','SHIPPED','DROPPED','TIMED_OUT')),
  drafted_payload  jsonb,
  created_at       timestamptz not null default now(),
  detected_at      timestamptz,
  unique (provenance_token)                     -- provenance is the idempotency key
);
-- NO unique(decision_id, metric_id): same-metric multi-lever is permitted.

create index levers_scope_id_idx  on public.levers(scope_id);
create index levers_status_idx    on public.levers(status);   -- cron scans DRAFTED/CREATED
create index levers_decision_idx  on public.levers(decision_id);

alter table public.levers enable row level security;
-- viewer reads, member writes — mirror the objectives/metrics policies.
create policy levers_select on public.levers for select to authenticated
  using (public.has_scope_access(scope_id,'viewer'));
create policy levers_insert on public.levers for insert to authenticated
  with check (public.has_scope_access(scope_id,'member'));
create policy levers_update on public.levers for update to authenticated
  using (public.has_scope_access(scope_id,'member'))
  with check (public.has_scope_access(scope_id,'member'));
-- No delete policy: default-deny (service_role bypasses RLS).

-- Explicit grants: CI's setup-cli applies no implicit defaults to
-- user-migration tables (see 20260709000000_grant_base_privileges.sql).
grant select, insert, update, delete on public.levers to authenticated, service_role;
grant select on public.levers to anon;

-- ============================================================================
-- is_lever becomes derivable (an action is a lever iff it has a levers row)
-- ============================================================================

alter table public.decision_actions drop column is_lever;

-- ============================================================================
-- declared metric (unwired, name-only)
-- ============================================================================
-- Constraint names confirmed against the live catalog (Supabase auto-named
-- them <table>_<col>_check).

alter table public.metrics drop constraint metrics_source_check;
alter table public.metrics add constraint metrics_source_check
  check (source in ('csv','connector','declared'));

-- ============================================================================
-- resolution state for a declared metric with no observations
-- ============================================================================

alter table public.predictions drop constraint predictions_resolved_verdict_check;
alter table public.predictions add constraint predictions_resolved_verdict_check
  check (resolved_verdict in ('CONFIRMED','DIRECTION_CONFIRMED','REFUTED','INCONCLUSIVE',
    'GATHERING','UNRESOLVABLE','VOIDED','UNATTRIBUTED','UNMEASURABLE_NO_METRIC'));
