-- Causent v1 schema — the decision graph + its scope/RBAC spine.
-- Columns mirror docs/designs/decision-graph.md exactly. RLS lives in the next
-- migration; every domain row carries scope_id -> workspaces (the operating level).

-- ============================================================================
-- SCOPE HIERARCHY  (org -> project -> workspace)
-- ============================================================================

create table public.orgs (
  org_id      uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.projects (
  project_id  uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(org_id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.workspaces (
  workspace_id uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(project_id) on delete cascade,
  name         text not null,
  created_at   timestamptz not null default now()
);

create index projects_org_id_idx on public.projects(org_id);
create index workspaces_project_id_idx on public.workspaces(project_id);

-- ============================================================================
-- MEMBERSHIP / RBAC  (user x scope x role — what makes RLS enforceable)
-- ============================================================================
-- A row grants `role` at its most-specific non-NULL scope and INHERITS downward.
-- org_id is always set (the tenant); NULL project/workspace widens the grant.
-- NULLS NOT DISTINCT so (user, org, NULL, NULL) can exist only once.

create table public.memberships (
  membership_id uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  org_id        uuid not null references public.orgs(org_id) on delete cascade,
  project_id    uuid references public.projects(project_id) on delete cascade,
  workspace_id  uuid references public.workspaces(workspace_id) on delete cascade,
  role          text not null check (role in ('owner','admin','member','viewer')),
  invited_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique nulls not distinct (user_id, org_id, project_id, workspace_id)
);

create index memberships_user_id_idx on public.memberships(user_id);
create index memberships_org_id_idx on public.memberships(org_id);

-- ============================================================================
-- METRICS  (the time-series spine)
-- ============================================================================

create table public.metrics (
  metric_id    uuid primary key default gen_random_uuid(),
  scope_id     uuid not null references public.workspaces(workspace_id) on delete cascade,
  name         text not null,
  source       text not null check (source in ('csv','connector')),
  granularity  text not null default 'daily',
  unit         text,
  tz           text not null default 'UTC'
);

create table public.metric_observations (
  metric_id  uuid not null references public.metrics(metric_id) on delete cascade,
  obs_date   date not null,
  value      numeric,
  primary key (metric_id, obs_date)
);

create index metrics_scope_id_idx on public.metrics(scope_id);

-- ============================================================================
-- CLUSTERS  (collision grouping — an overlay, never a replacement)
-- ============================================================================

create table public.clusters (
  cluster_id    uuid primary key default gen_random_uuid(),
  scope_id      uuid not null references public.workspaces(workspace_id) on delete cascade,
  metric_id     uuid not null references public.metrics(metric_id) on delete cascade,
  window_start  date not null,
  window_end    date not null
);

create index clusters_scope_id_idx on public.clusters(scope_id);
create index clusters_metric_id_idx on public.clusters(metric_id);

-- ============================================================================
-- ACTIONS  (the shipped work)
-- ============================================================================

create table public.actions (
  action_id           uuid primary key default gen_random_uuid(),
  scope_id            uuid not null references public.workspaces(workspace_id) on delete cascade,
  cluster_id          uuid references public.clusters(cluster_id) on delete set null,
  source              text not null check (source in ('github_pr','github_issue','manual')),
  external_ref        text,
  ship_ts             timestamptz,
  effective_date      date,
  owner_id            uuid references auth.users(id) on delete set null,
  status              text,
  rationale_richtext  jsonb
);

create index actions_scope_id_idx on public.actions(scope_id);
create index actions_cluster_id_idx on public.actions(cluster_id);

-- ============================================================================
-- GRAPH  (materialized from the above)
-- ============================================================================

create table public.nodes (
  node_id       uuid primary key default gen_random_uuid(),
  scope_id      uuid not null references public.workspaces(workspace_id) on delete cascade,
  type          text not null check (type in ('METRIC','ACTION','CLUSTER')),
  semantic_ref  uuid not null,   -- = metric_id | action_id | cluster_id (polymorphic, no FK)
  display_name  text
);

create table public.causal_edges (
  edge_id               uuid primary key default gen_random_uuid(),
  scope_id              uuid not null references public.workspaces(workspace_id) on delete cascade,
  source_node_id        uuid not null references public.nodes(node_id) on delete cascade,  -- ACTION or CLUSTER
  target_node_id        uuid not null references public.nodes(node_id) on delete cascade,  -- METRIC
  direction             text not null check (direction in ('POSITIVE','NEGATIVE','INCONCLUSIVE')),
  belief_score          real,   -- 0..1, or NULL for "we don't know"
  authoritative_method  text,
  last_updated          timestamptz not null default now()
);

create index nodes_scope_id_idx on public.nodes(scope_id);
create index nodes_semantic_ref_idx on public.nodes(semantic_ref);
create index causal_edges_scope_id_idx on public.causal_edges(scope_id);
create index causal_edges_source_node_id_idx on public.causal_edges(source_node_id);
create index causal_edges_target_node_id_idx on public.causal_edges(target_node_id);

-- ============================================================================
-- EVIDENCE  (append-only — audit trail + ML feedstock)
-- ============================================================================
-- One row per action x metric x method run. Raw stats stored so the deferred
-- belief model can recompute without re-running the engine. Append-only is
-- enforced in the RLS migration (no UPDATE/DELETE policy + privilege REVOKE).

create table public.evidence_objects (
  evidence_id       uuid primary key default gen_random_uuid(),
  scope_id          uuid not null references public.workspaces(workspace_id) on delete cascade,
  edge_id           uuid not null references public.causal_edges(edge_id) on delete cascade,
  action_id         uuid references public.actions(action_id) on delete set null,
  cluster_id        uuid references public.clusters(cluster_id) on delete set null,
  methodology       text not null check (methodology in ('ITS','BEFORE_AFTER_14D','MANUAL')),
  lift              real,
  ci_low            real,
  ci_high           real,
  confounded        boolean not null default false,
  clustered         boolean not null default false,
  n_pre             integer,
  n_post            integer,
  resid_var         numeric,
  cond_number       numeric,
  placebo_lift      real,
  placebo_fired     boolean not null default false,
  authorship_token  jsonb,
  created_at        timestamptz not null default now()
);

create index evidence_objects_scope_id_idx on public.evidence_objects(scope_id);
create index evidence_objects_edge_id_idx on public.evidence_objects(edge_id);
create index evidence_objects_action_id_idx on public.evidence_objects(action_id);
