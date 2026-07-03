-- Causent v1 RLS — isolation via the memberships table over the scope hierarchy.
-- Every table has RLS enabled. Access resolves through SECURITY DEFINER helpers
-- (which read memberships bypassing RLS, so membership policies don't recurse).
--
-- Grant semantics (docs/designs/security-and-auth.md):
--   viewer < member < admin < owner. A membership INHERITS downward: an org-level
--   grant covers every project + workspace under it; a workspace grant covers only
--   that workspace. SELECT needs viewer+, data writes need member+, membership /
--   scope-management writes need admin+ (owner sits above admin for delete/billing,
--   handled server-side). service_role bypasses RLS for engine/server bootstrap.

-- ============================================================================
-- HELPERS
-- ============================================================================

-- Total order over roles; the single source of truth for role comparison.
create function public.role_rank(role text)
returns integer language sql immutable as $$
  select case role
    when 'owner'  then 4
    when 'admin'  then 3
    when 'member' then 2
    when 'viewer' then 1
    else 0
  end;
$$;

-- Core downward-inheriting match: does the current user hold a membership that
-- COVERS the target (org, project, workspace) at >= min_role? A NULL grant level
-- on the membership widens it (org-wide / project-wide).
create function public.has_scope_grant(
  t_org uuid, t_project uuid, t_workspace uuid, min_role text
) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.org_id = t_org
      and (m.project_id is null or m.project_id = t_project)
      and (m.workspace_id is null or m.workspace_id = t_workspace)
      and public.role_rank(m.role) >= public.role_rank(min_role)
  );
$$;

-- The scope helper the domain tables use: scope_id is always a workspace_id.
-- Resolves the workspace's project + org, then defers to has_scope_grant.
create function public.has_scope_access(target_scope uuid, min_role text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select public.has_scope_grant(p.org_id, w.project_id, w.workspace_id, min_role)
    from public.workspaces w
    join public.projects p on p.project_id = w.project_id
    where w.workspace_id = target_scope
  ), false);
$$;

-- Upward visibility for the hierarchy tables: any member of the org (at any level)
-- can see the org node.
create function public.has_org_access(t_org uuid, min_role text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.org_id = t_org
      and public.role_rank(m.role) >= public.role_rank(min_role)
  );
$$;

-- A member covering a project = an org-level grant, a grant on the project, or a
-- grant on any workspace under it (its project_id equals this project).
create function public.has_project_access(t_project uuid, min_role text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.org_id = (select org_id from public.projects where project_id = t_project)
      and (m.project_id is null or m.project_id = t_project)
      and public.role_rank(m.role) >= public.role_rank(min_role)
  );
$$;

-- Resolve a metric's scope for metric_observations (which carries no scope_id).
create function public.metric_scope(t_metric uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select scope_id from public.metrics where metric_id = t_metric;
$$;

-- ============================================================================
-- ENABLE RLS ON EVERY TABLE
-- ============================================================================

alter table public.orgs                enable row level security;
alter table public.projects            enable row level security;
alter table public.workspaces          enable row level security;
alter table public.memberships         enable row level security;
alter table public.metrics             enable row level security;
alter table public.metric_observations enable row level security;
alter table public.clusters            enable row level security;
alter table public.actions             enable row level security;
alter table public.nodes               enable row level security;
alter table public.causal_edges        enable row level security;
alter table public.evidence_objects    enable row level security;

-- ============================================================================
-- SCOPE HIERARCHY POLICIES
-- ============================================================================
-- orgs/projects/workspaces creation flows through the server (service_role) at
-- signup; owner-only org delete is also server-side. No INSERT/DELETE policy for
-- authenticated here is intentional (RLS default-deny).

create policy orgs_select on public.orgs for select to authenticated
  using (public.has_org_access(org_id, 'viewer'));
create policy orgs_update on public.orgs for update to authenticated
  using (public.has_org_access(org_id, 'admin'))
  with check (public.has_org_access(org_id, 'admin'));

create policy projects_select on public.projects for select to authenticated
  using (public.has_project_access(project_id, 'viewer'));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.has_org_access(org_id, 'admin'));
create policy projects_update on public.projects for update to authenticated
  using (public.has_project_access(project_id, 'admin'))
  with check (public.has_project_access(project_id, 'admin'));

create policy workspaces_select on public.workspaces for select to authenticated
  using (public.has_scope_access(workspace_id, 'viewer'));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (public.has_project_access(project_id, 'admin'));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_scope_access(workspace_id, 'admin'))
  with check (public.has_scope_access(workspace_id, 'admin'));

-- ============================================================================
-- MEMBERSHIP POLICIES  (admin+ over the granted scope manages members)
-- ============================================================================

create policy memberships_select on public.memberships for select to authenticated
  using (public.has_scope_grant(org_id, project_id, workspace_id, 'viewer'));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (public.has_scope_grant(org_id, project_id, workspace_id, 'admin'));
create policy memberships_update on public.memberships for update to authenticated
  using (public.has_scope_grant(org_id, project_id, workspace_id, 'admin'))
  with check (public.has_scope_grant(org_id, project_id, workspace_id, 'admin'));
create policy memberships_delete on public.memberships for delete to authenticated
  using (public.has_scope_grant(org_id, project_id, workspace_id, 'admin'));

-- ============================================================================
-- DOMAIN TABLE POLICIES  (SELECT viewer+, INSERT/UPDATE member+, scoped by row)
-- ============================================================================

create policy metrics_select on public.metrics for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy metrics_insert on public.metrics for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy metrics_update on public.metrics for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));

-- metric_observations carries no scope_id; access resolves through its metric.
create policy metric_observations_select on public.metric_observations for select to authenticated
  using (public.has_scope_access(public.metric_scope(metric_id), 'viewer'));
create policy metric_observations_insert on public.metric_observations for insert to authenticated
  with check (public.has_scope_access(public.metric_scope(metric_id), 'member'));
create policy metric_observations_update on public.metric_observations for update to authenticated
  using (public.has_scope_access(public.metric_scope(metric_id), 'member'))
  with check (public.has_scope_access(public.metric_scope(metric_id), 'member'));

create policy clusters_select on public.clusters for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy clusters_insert on public.clusters for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy clusters_update on public.clusters for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));

create policy actions_select on public.actions for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy actions_insert on public.actions for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy actions_update on public.actions for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));

create policy nodes_select on public.nodes for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy nodes_insert on public.nodes for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy nodes_update on public.nodes for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));

create policy causal_edges_select on public.causal_edges for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy causal_edges_insert on public.causal_edges for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));
create policy causal_edges_update on public.causal_edges for update to authenticated
  using (public.has_scope_access(scope_id, 'member'))
  with check (public.has_scope_access(scope_id, 'member'));

-- ============================================================================
-- EVIDENCE  (append-only: SELECT viewer+, INSERT member+, no UPDATE/DELETE)
-- ============================================================================
-- Belief is a projection of the latest authoritative evidence row; rows are never
-- mutated. RLS grants no UPDATE/DELETE policy, and the privilege REVOKE below is a
-- second, table-level guard so append-only holds even if a policy were later added.

create policy evidence_select on public.evidence_objects for select to authenticated
  using (public.has_scope_access(scope_id, 'viewer'));
create policy evidence_insert on public.evidence_objects for insert to authenticated
  with check (public.has_scope_access(scope_id, 'member'));

-- TRUNCATE is not row-level; RLS can't stop it, so it must be revoked too or a
-- member could wipe the audit trail wholesale.
revoke update, delete, truncate on public.evidence_objects from authenticated, anon;
