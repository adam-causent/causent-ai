# Causent Decision Graph — Data Model & Roadmap

Status: LIVING DOCUMENT (v1 schema locked 2026-07-02; intelligence roadmap open)
Owner: founder
Related: `docs/designs/did-it-ship-did-it-work.md` (the v1 build plan / PRD)

## Why this document exists

The decision graph (a.k.a. the causal graph) is **the core asset of the company.**
Neither causal inference nor GitHub-reading is a defensible moat on its own (see the
competitive analysis in the PRD). What compounds is the graph itself: an append-only,
per-scope record of *which shipped actions moved which metrics, by how much, with what
confidence.* Over time that record becomes an organization's decision memory and the
training substrate for cross-project learning. This doc is the canonical home for its
data model and the roadmap of intelligence built on top. It will grow.

## Design principles

1. **Derived, not stored-as-a-graph.** The graph is materialized from relational
   tables in **Postgres only** — no Neo4j/Neptune, no `pgvector` in v1. The canvas is
   a query over `nodes` + `causal_edges`, rendered by React Flow. One source of truth,
   no second datastore to keep in sync.
2. **Evidence is append-only.** Every readout writes a new `evidence_objects` row and
   never mutates an old one. Belief is a projection of the latest authoritative row.
   This gives a full audit trail AND the raw feedstock the future learning loop needs.
3. **Capture raw stats now, learn later.** Store `n_pre`, `n_post`, residual variance,
   condition number, and the placebo result on every evidence row so the deferred
   belief-learning model can recompute belief without re-running the engine. This is
   what makes the wedge→platform path (B→C) a refinement, not a rewrite.
4. **Scope everything.** Every row carries a scope in the org → project → workspace
   hierarchy. RLS enforces isolation; the ML learns and transfers at the right level.
5. **Belief is confidence-that-effect≠0, not desirability.** A strong *negative*
   effect is high-belief. Sign lives in `direction`, magnitude in the edge weight.

## Storage: the tables (v1)

```
SCOPE HIERARCHY  (the ML spine + the access-control spine)
  orgs        (org_id PK, name, created_at)
  projects    (project_id PK, org_id FK→orgs, name, created_at)          e.g. "Orbit"
  workspaces  (workspace_id PK, project_id FK→projects, name, created_at) e.g. "Gummy Alpha"
  # every table below carries scope_id → workspaces (the operating level in v1)

MEMBERSHIP / RBAC  (what makes RLS enforceable across the hierarchy)
  memberships (membership_id PK, user_id FK→auth.users,
               org_id FK→orgs,                    # always set (the tenant)
               project_id FK?→projects,           # NULL = grant applies org-wide
               workspace_id FK?→workspaces,        # NULL = applies to whole project/org
               role∈{owner,admin,member,viewer},
               invited_by, created_at,
               UNIQUE (user_id, org_id, project_id, workspace_id))
  # A membership row grants `role` at the most specific non-NULL scope and INHERITS
  # downward: an org-level admin admins every project/workspace under it; a
  # workspace-level viewer sees only that workspace. RLS resolves access by checking
  # for a membership whose scope covers the row's scope_id.
  # Roles: owner (billing + delete + members), admin (manage data + members),
  #        member (create/edit actions, metrics, rationale), viewer (read-only).

METRICS  (the time-series spine)
  metrics             (metric_id PK, scope_id FK, name, source∈{csv,connector},
                       granularity='daily', unit, tz DEFAULT 'UTC')       ≤5 in v1
  metric_observations (metric_id FK, obs_date DATE, value NUMERIC,
                       PRIMARY KEY (metric_id, obs_date))                  the daily series

ACTIONS  (the shipped work)
  actions   (action_id PK, scope_id FK, cluster_id FK?→clusters,
             source∈{github_pr,github_issue,manual}, external_ref,
             ship_ts TIMESTAMPTZ, effective_date DATE, owner_id, status,
             rationale_richtext JSONB)   # the "why we built it" editor content

CLUSTERS  (collision grouping — an overlay, never a replacement)
  clusters  (cluster_id PK, scope_id FK, metric_id FK, window_start, window_end)

GRAPH  (materialized from the above)
  nodes         (node_id PK, scope_id FK, type∈{METRIC,ACTION,CLUSTER},
                 semantic_ref,           # = metric_id | action_id | cluster_id
                 display_name)
  causal_edges  (edge_id PK, scope_id FK,
                 source_node_id FK→nodes,  # ACTION or CLUSTER
                 target_node_id FK→nodes,  # METRIC
                 direction∈{POSITIVE,NEGATIVE,INCONCLUSIVE},
                 belief_score REAL,        # 0..1 or NULL
                 belief_reason,            # NULL | INSUFFICIENT_HISTORY | AUTOCORRELATION | FDR_DEMOTED | PLACEBO | DEGENERATE
                 authoritative_method,     # which method drives direction+belief (ITS in v1)
                 last_updated TIMESTAMPTZ)

EVIDENCE  (append-only — audit trail + ML feedstock)
  evidence_objects (evidence_id PK, scope_id FK, edge_id FK→causal_edges,
                    action_id FK?, cluster_id FK?,
                    methodology∈{ITS, BEFORE_AFTER_14D, MANUAL},
                    lift?, ci_low?, ci_high?,
                    confounded BOOL, clustered BOOL,
                    n_pre INT, n_post INT, resid_var, cond_number,       # raw stats
                    p_value?, durbin_watson?,                             # HAC significance + autocorrelation
                    placebo_lift?, placebo_fired BOOL,                    # E3 placebo
                    authorship_token JSONB,   # denormalized who-authored snapshot
                    created_at TIMESTAMPTZ)
```

### ER sketch

```
 orgs ─1:N─ projects ─1:N─ workspaces(scope)
                                  │ (scope_id on every row)
        ┌────────────┬───────────┼───────────┬───────────────┐
        ▼            ▼           ▼           ▼               ▼
     metrics      actions     clusters     nodes         causal_edges
        │            │           │        (METRIC/       (ACTION|CLUSTER
        ▼            │           │         ACTION/         → METRIC)
 metric_observations │           │         CLUSTER)            │
   (daily series)    └───────────┴─────────────┐              │
                                                ▼              ▼
                                          evidence_objects ────┘
                                          (append-only, one per
                                           action×metric×method run)
```

## How the graph is built (pipeline)

```
1. INGEST ACTIONS   GitHub PR merge / manual entry ─▶ actions row ─▶ ACTION node
2. INGEST METRICS   CSV upload (date,value) ─▶ metrics + metric_observations ─▶ METRIC node
3. COMPUTE          for each (action × metric) whose effective_date falls in the metric's
                    post-window, the Vercel Python engine runs the method registry
                    (BEFORE_AFTER_14D + ITS) on the series ─▶ append evidence_objects
                    (with raw stats + placebo). Batched: one engine call per metric returns
                    one row PER ACTION × method.
4. MATERIALIZE EDGE upsert one causal_edges row per (action→metric); direction + belief_score
                    recompute from the latest **authoritative (ITS)** evidence row — NOT
                    latest-by-created_at.
5. CLUSTER OVERLAY  co-occurring same-metric actions ─▶ CLUSTER node + CLUSTER→METRIC edge,
                    while each action KEEPS its own ACTION→METRIC edge (clustered=true).
                    Belief carried by the cluster edge; members not zeroed.
```

## Belief & direction rules (v1)

Recompute from the latest **authoritative-method** (ITS) evidence row for the edge:

| Condition (ITS) | belief_score | direction | reason |
|---|---|---|---|
| CI excludes zero, **survives BH-FDR**, placebo did **not** fire, **DW ≥ 1.3**, **both sides ≥ 45 days** | 1.0 | sign of lift (POSITIVE / NEGATIVE) | — |
| CI excludes zero but **fails BH-FDR** (not significant after correction) | 0.5 | INCONCLUSIVE | — |
| CI excludes zero but **residual autocorrelation too strong** (Durbin-Watson < 1.3) | 0.5 | INCONCLUSIVE | `AUTOCORRELATION` |
| **placebo-in-time fired** (falsified — method fabricates structure) | 0.0 | INCONCLUSIVE | `PLACEBO` |
| 95% CI includes zero | 0.5 | INCONCLUSIVE | — |
| confounded | 0.0 | INCONCLUSIVE | — |
| **degenerate fit** (rank / condition / variance — unusable) | NULL | INCONCLUSIVE | `DEGENERATE` |
| **below the confident floor** (fittable, but a side < 45 days) | NULL | INCONCLUSIVE | `INSUFFICIENT_HISTORY` |
| insufficient data (<28 pts) | NULL | INCONCLUSIVE | — |
| MANUAL evidence only | 0.3 | sign of stated expectation | — |

**0.0 vs NULL is load-bearing.** `0.0` means *"no credible effect"* — confounded, or a
readout the placebo falsified. `NULL` means *"we don't know"* — too little data, or a
fit too degenerate to trust. A degenerate fit is UNKNOWN, never "no effect", so it maps
to NULL (reason `DEGENERATE`), not 0.0.

**Falsification gates belief.** Belief 1.0 requires the readout to survive four guards
beyond its own CI: (1) the **placebo-in-time** check must not fire — the same method,
aimed at a fake pre-period intervention adjacent to the real split, must find nothing; a
firing placebo drops the edge to 0.0 (reason `PLACEBO`), and a placebo that is *not
evaluable* withholds the 1.0 (demote to 0.5) rather than granting it. (2)
**Benjamini-Hochberg FDR at q=0.05** across all actions tested against the metric — one
metric fans out to many actions, so a per-action nominal p<0.05 inflates false edges; an
edge that fails BH-FDR is demoted to 0.5. (3) **Confident floor** — at least **45 days of
history on each side** (`FLOOR_CONFIDENT`); a fittable-but-below-floor readout is withheld
as `INSUFFICIENT_HISTORY` (belief NULL, "gathering data"), never staked as a causal claim.
(4) **Durbin-Watson ≥ 1.3** (`DW_CONFIDENT_MIN`) — residual autocorrelation stronger than
the small-sample HAC correction can reliably absorb at n=28–60 caps belief at 0.5 (reason
`AUTOCORRELATION`). Below the floor, belief is NULL; the descriptive before/after still
shows a labeled number so the product is never blank.

### Methods: DESCRIPTIVE vs CAUSAL

Two methods run on every series, and the distinction is load-bearing for honesty:

- **`BEFORE_AFTER_14D` (always-on 7d/14d) is DESCRIPTIVE, not causal.** It reports the
  raw mean shift across the split with a Welch interval. It is stored and shown as a
  **descriptive cross-check only** — it never drives `direction`/`belief_score`, and the
  UI labels it as descriptive so a mean difference is never mistaken for an effect.
- **`ITS` (segmented OLS + HAC + placebo + floor/DW guards) is the CAUSAL method** and the
  sole authority for `direction`/`belief_score`. It is a **frequentist interrupted
  time-series** — segmented regression with a Newey-West HAC covariance and the
  falsification guards above. It is **explicitly NOT CausalImpact / a Bayesian
  structural-time-series (BSTS) model**: no synthetic control, no state-space prior, no
  posterior — those are deferred (see the intelligence roadmap), not what v1 ships.

On method disagreement, ITS wins and the UI widens the uncertainty caveat (never shows the
descriptive method's tighter interval as more trustworthy).

## Rendering (one authoritative view per edge)

React Flow renders each edge with a single `(method, scope)` = the authoritative ITS
result: color = direction (colorblind-safe: also glyph ▲/▼/– + label), opacity/weight =
belief_score. The non-authoritative method and any cluster readout live in the edge's
detail panel, not on the glyph. Uncertain states stay distinguishable: insufficient =
dashed grey (belief NULL), CI-includes-zero = thin neutral (0.5), confounded = hatched
grey (0.0), placebo-N/A = "trust unverified".

## Invariants (do not break)

- Evidence is **append-only**; belief is a projection, never a stored mutation.
- Every row is scoped; **RLS on every table** resolves access via the `memberships`
  table (a membership whose scope covers the row's `scope_id`, at a sufficient role).
  Auth flows, roles, and the full policy live in `docs/designs/security-and-auth.md`.
- The causal engine is **stateless compute** — it receives the RLS-scoped series as
  data and holds no DB credentials (it must not self-query with the service role).
- One **authoritative method** per edge decides direction + belief; others are detail.

## Intelligence roadmap (deferred — the platform track)

v1 ships the graph as **data model + visual**. The intelligence below is deferred until
there is enough captured evidence to train it. This is where most future work lives.

| Phase | Capability | Depends on |
|---|---|---|
| P1 (v1) | Capture every action→metric edge + raw stats; render honestly | — |
| P2 | **Belief decay** — belief ages as the world drifts; re-weight by recency | evidence volume |
| P2 | **Method expansion** — diff-in-diff (when a clean A/B exists), SEGMENT nodes | A/B data |
| P3 | **Path analysis** — multi-hop action→metric→metric chains; indirect effects | edge density |
| P3 | **Cross-project pattern ML** — "changes like this usually move retention ~X%" | org/project hierarchy + many workspaces |
| P4 | **Second-order simulation** — predict a proposed action's likely impact before shipping | trained belief model |
| P4 | **Recommendations** — suggest next highest-EV action | simulation |

## Open questions

- **Belief-decay function:** exponential vs event-triggered (re-decay on a same-metric ship)?
- **Cross-project transfer unit:** what makes two actions "similar" for pattern ML — the
  metric type, the action semantics (embedding), the diff shape?
- **Cluster resolution ordering** inside one batch invocation when many same-metric actions
  co-occur (needs a deterministic algorithm — see PRD collision handling).
- **Edge lifecycle:** when an action's `effective_date` is edited, do we supersede the old
  evidence row or append a correction? (Leaning append + recompute.)
- **Graph scale:** node cap / top-N-by-belief once a chatty repo backfills thousands of edges.

## Change log

- 2026-07-03 — Honest-inference rebuild. Belief rules now reflect the shipped engine:
  added `INSUFFICIENT_HISTORY` (belief NULL below the 45-day/side confident floor) and
  `AUTOCORRELATION` (belief 0.5 when Durbin-Watson < 1.3) rows; belief 1.0 now also
  requires DW ≥ 1.3 and both sides ≥ 45 days; placebo placed adjacent to the real split so
  it fires in-regime, and a not-evaluable placebo withholds 1.0. Added a Methods note
  distinguishing the DESCRIPTIVE `BEFORE_AFTER_14D` from the CAUSAL frequentist ITS
  (explicitly not CausalImpact / Bayesian structural-time-series). Coverage gate green.
- 2026-07-02 — Initial model. Locked v1 schema; added scope hierarchy (org→project→
  workspace), `BEFORE_AFTER_14D` methodology, authoritative-method belief key, raw-stats
  columns on evidence, clustering-as-overlay, and the intelligence roadmap. Sourced from
  the PRD + CEO/Eng/Design review decisions.

## v2 — prospective intent + prediction layer (2026-07-11)

`prospective-prediction-loop.md` adds an **intent layer UPSTREAM** of this causal graph.
It does not change the ITS belief model or the ACTION/CLUSTER→METRIC edge model below —
new objects sit above them:
- **`decisions`** (intent) + **`decision_actions(is_lever)`** — a decision parents many
  actions; `is_lever` marks the ticket carrying the mechanism. NOT a `nodes`/`causal_edges`
  participant (the causal layer stays clean).
- **`predictions`** (human pre-registered; distinct from engine-measured
  `evidence_objects`) + `prediction_revisions` (append-only). Resolves against the ITS
  `causal_edge` for the lever action→metric at `resolution_date`.
- **`transition_events`** (append-only work-item transitions) — drives drift + sets the
  intervention date.
- **Resolution verdict machine** maps every belief-table state (this doc's "Belief &
  direction rules") to a verdict (`CONFIRMED` / `DIRECTION_CONFIRMED` / `REFUTED` /
  `INCONCLUSIVE` / `GATHERING` / `UNRESOLVABLE` / `VOIDED` / `UNATTRIBUTED`). Scoring is
  sign-primary + magnitude-in-CI bonus, %-of-mean units.
- **Priors/memory:** store the full resolution tuple; include REFUTED + INCONCLUSIVE
  (no survivorship bias); weight by `belief_score`; compute on-the-fly in v1. This is a
  concrete near-term instance of the deferred P4 "second-order simulation" roadmap row —
  but the HUMAN authors the prediction, not the model.
