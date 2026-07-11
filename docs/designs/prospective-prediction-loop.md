# Causent — Prospective Prediction Loop (wedge on-ramp)

Status: DESIGN (approved via /plan-ceo-review + /plan-eng-review, 2026-07-11)
Relates to: `did-it-ship-did-it-work.md` (the retrospective wedge — retained),
`decision-graph.md` (the causal-graph data model this extends).
Does NOT supersede either: this ADDS a prospective on-ramp; the retrospective path stays.

## Why this doc exists

The standing moat thesis holds: defensibility is the **accreting causal graph**, not
causal-inference or GitHub-reading. But the retrospective wedge (measure what already
shipped vs metrics that already moved) returns **zero on an empty graph** — it needs 45
days of history and a change already old enough to measure before it shows a single
number. So nothing pulls in the first decision, and a graph that never accretes makes
every downstream asset (memory, priors, causal readout) stillborn.

This doc adds the missing on-ramp: a **human pre-registered prediction with a resolution
date**. It has day-one value (forces the decision concrete, surfaces disagreement in the
room) AND deposits the exact pre-registered substrate the graph needs — methodologically
stronger than retrospective reconstruction. Causent becomes the only system holding both
the stated intent and the work stream, so it can say the one sentence no lab model and no
ticket tracker can: *"your work just stopped matching your intent."*

## Product

### Dual cold-start (one graph, two on-ramps)

The graph accretes from whichever end the user enters:

```
  DATA-RICH user (history, change shipped 45d+ ago)
      └─▶ retrospective ITS readout NOW  ─▶ evidence_objects (measured)   ┐
                                                                          ├─▶ one causal_edge
  NEW user (little history)                                              │      per (action→metric)
      └─▶ prediction NOW ─(resolution_date)─▶ ITS scores it ─▶ evidence  ┘
```

Every user, both kinds, pre-registers predictions going forward — so even the data-rich
user's graph gets methodologically stronger (prospective) edges layered on the
retrospective ones. Never turn a user away for too little OR too much data.

### The loop (cold-start flow)

1. **Login.** Nothing else. (Auth: invite-only Google OAuth — see issue #5.)
2. **One question, no setup:** "What are you about to build, and what do you expect it to
   change?" Paste a doc / Slack thread / ticket, or type it. No connector wall.
3. **Causent structures + interrogates.** Names the primary metric. Forces the mechanism
   explicit (what changes, why would that move the metric). Surfaces what's unstated. This
   is the guardrail a general chatbot won't provide (it's tuned to agree).
4. **The team commits the prediction** — direction, magnitude, metric, resolution date.
   Causent supplies precedent/evidence to INFORM it; on an empty graph it honestly says
   "no precedent yet — record your prior." The team's number, never the model's.
5. **Motivated connector ask:** "To tell you if the work drifts from this, I need to watch
   the tickets/PRs. Connect Jira/GitHub." Now the price of a benefit they just understood.
6. **Decision list + mechanism→ticket (`is_lever`) mapping.** Mark which ticket carries the
   lever. LLM proposes, human confirms. **The drift signal depends entirely on this step.**
7. **Ship.** Causent watches.
8. **Payoffs:** session-one = the commitment artifact (decision + mechanism + metric +
   date + surfaced disagreement). First real payoff = the first drift alert (days). Big
   payoff = the resolution readout ("here's what you said, here's what happened").

### Elicit vs assert (load-bearing honesty rule)

- **Prospective** (predicting a not-yet-shipped change): the HUMAN commits the number. The
  engine INFORMS with precedent but NEVER generates the prospective prediction — an
  engine-authored prediction on a thin graph is a confidently-wrong causal claim and
  collects the model's opinion instead of the team's belief (destroys the pre-registration
  asset that is the moat).
- **Retrospective** (a change already shipped 45d+ ago): the engine ASSERTS a MEASURED
  lift from real history. Legitimate — measurement, not prediction.
- **Resolution:** the engine MEASURES the prospective prediction at its `resolution_date`
  (assert is correct here — after the fact).

### Prediction = team commitment, not personal scorecard

Capture as "we predict," shared, not attributed to one person — collective belief reads as
alignment; a shared miss reads as learning. Predictions are **revisable with a logged
reason** (a revision is data, not a failure). This converts the load-bearing
accountability-aversion risk from an exposure problem into the alignment value teams want.

### Capture locus: embedded

Commit + drift alert happen **where the team already works** — a Slack command, a Jira
panel, or an MCP the coding agent calls at plan time. The Causent web app is the
destination for the **deep resolution readout + graph**. Frequent actions ride existing
habits; the visual destination is reserved for the high-value payoff. (Rejected:
destination-first — must win a new daily habit, the wrapper-trap; embedded-only — no rich
home for the resolution payoff.)

## The signal — drift (assert-fact / ask-interpretation)

The only honest thing to say during the build window (outcome hasn't happened yet) is
whether the work has drifted from the committed intent. The killer signal: **the lever
ticket carrying the predicted mechanism was structurally dropped.**

The alert states only the **verifiable fact** (read straight from a webhook — never wrong)
and **asks the human** about the interpretation (never declares a prediction dead):

> "PROJ-142 carried the mechanism behind your +3% activation prediction, and it just moved
> out of this sprint. Is the prediction still on, or do you want to revise it?"

- **Conservative trigger taxonomy — fire ONLY on unambiguous lever transitions:**
  closed-wontfix, descoped, removed-from-active-sprint. NEVER re-point / re-assign /
  re-title. Precision at the trigger, not vagueness at the message.
- Rejected: vague/soft alerts (kill the specificity that IS the differentiator; get muted);
  confidence-scored assertions (re-introduce a confidently-wrong claim in a notification).

## Data model (extends `decision-graph.md`)

New objects sit **upstream** of the existing action→metric causal graph. Decisions are NOT
`nodes`/`causal_edges` participants — the causal layer stays clean (still ACTION/CLUSTER →
METRIC). Decisions are the intent layer that groups actions and owns predictions.

```sql
-- The intent layer -----------------------------------------------------------
create table public.decisions (
  decision_id  uuid primary key default gen_random_uuid(),
  scope_id     uuid not null references public.workspaces(workspace_id) on delete cascade,
  title        text not null,
  rationale    jsonb,                 -- the "why"
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- decision → many actions; is_lever marks which ticket carries the mechanism.
create table public.decision_actions (
  decision_id  uuid not null references public.decisions(decision_id) on delete cascade,
  action_id    uuid not null references public.actions(action_id) on delete cascade,
  is_lever     boolean not null default false,
  primary key (decision_id, action_id)
);

-- Human pre-registered prediction — distinct from engine-measured evidence_objects.
create table public.predictions (
  prediction_id       uuid primary key default gen_random_uuid(),
  scope_id            uuid not null references public.workspaces(workspace_id) on delete cascade,
  decision_id         uuid not null references public.decisions(decision_id) on delete cascade,
  metric_id           uuid not null references public.metrics(metric_id) on delete cascade,
  direction           text not null check (direction in ('POSITIVE','NEGATIVE')),
  magnitude_pct_mean  real not null,          -- %-of-metric-mean (reuse E1/E2 convention)
  resolution_date     date not null,
  -- Team commitment, not personal scorecard: author context + append-only revisions.
  committed_by        uuid references auth.users(id) on delete set null,
  committed_at        timestamptz not null default now(),
  -- Resolution linkage (set at resolution time when ITS runs):
  resolved_edge_id    uuid references public.causal_edges(edge_id) on delete set null,
  resolved_verdict    text,                   -- see "Resolution verdict machine"
  resolved_at         timestamptz
);
-- v1 constraint: one lever per (decision, metric) so resolution is unambiguous.

create table public.prediction_revisions (   -- append-only; a revision is data, not failure
  revision_id     uuid primary key default gen_random_uuid(),
  prediction_id   uuid not null references public.predictions(prediction_id) on delete cascade,
  old_magnitude   real, old_direction text, new_magnitude real, new_direction text,
  reason          text not null,
  revised_by      uuid references auth.users(id) on delete set null,
  revised_at      timestamptz not null default now()
);

-- Work-item transitions — append-only, drives drift + sets the intervention date.
create table public.transition_events (
  event_id          uuid primary key default gen_random_uuid(),
  action_id         uuid not null references public.actions(action_id) on delete cascade,
  from_status       text, to_status text,
  canonical         text not null check (canonical in ('LEVER_DROPPED','LEVER_SHIPPED','LEVER_ACTIVE')),
  source            text not null check (source in ('jira','github')),
  provider_event_id text not null,            -- idempotency key
  transition_ts     timestamptz not null,
  raw_payload       jsonb,
  unique (source, provider_event_id)          -- webhook redelivery = no-op
);

-- actions.source enum must gain 'jira':
--   alter table public.actions drop constraint ...; add check (source in
--   ('github_pr','github_issue','jira','manual'));
```

RLS on every new table via `has_scope_access()`, mirroring existing domain tables. The
`(scope_id, external_ref)` partial unique index on `actions` already exists
(`actions_scope_external_ref_uniq`, migration `20260704000000`) — the connector reuses it.

## Causal inference & stats

### Resolution verdict machine

Resolution has two axes — *is it resolvable yet* (belief NULL) and *did the prediction
hold* — and conflating them is what makes a readout dishonest. Mapped onto the ITS belief
table in `decision-graph.md`:

| ITS state (belief table) | Verdict | User-facing |
|---|---|---|
| 1.0, direction matches, magnitude in CI | `CONFIRMED` | "You called it" |
| 1.0, direction matches, magnitude outside CI | `DIRECTION_CONFIRMED` | "Right way, off on size" |
| 1.0, direction opposite | `REFUTED` | "Moved the other way" (strongest learning) |
| 0.0/0.5 INCONCLUSIVE (FDR / autocorr / CI-incl-0 / placebo / confounded) | `INCONCLUSIVE` | "No confident signal — unproven, not wrong" |
| NULL `INSUFFICIENT_HISTORY` / <28 pts | `GATHERING` | "Not yet — N more days"; auto-extend `resolution_date` + notify |
| NULL `DEGENERATE` | `UNRESOLVABLE` | "Can't measure cleanly here" (terminal) |
| lever never shipped (no intervention date) | `VOIDED` | "The lever never shipped" (ties to drift) |
| prediction with no mapped lever | `UNATTRIBUTED` | warn at commit; "no action to measure" |

- **Scoring predicate: sign-primary + magnitude-in-CI bonus.** CONFIRMED requires the
  measured direction to match; a separate "magnitude in CI" badge marks whether the size
  was also right. NOT a hard magnitude gate — that punishes committing a number and biases
  priors; NOT sign-only — that discards the calibration signal.
- **Magnitude units:** %-of-metric-mean (reuse E1/E2). Predictions and the engine speak the
  same units.
- **GATHERING** auto-extends the resolution date rather than false-resolving as
  INCONCLUSIVE — a not-yet is not a no.

### Memory / priors (the accreting-graph payoff)

The verdict is a cosmetic label; **memory lives in the stored tuple.** On every resolution
persist `predicted_direction, predicted_magnitude, measured_direction, measured_lift,
ci_low, ci_high, belief_score, belief_reason, verdict, resolved_at` + the decision's
reference-class features (metric, action labels, mechanism category).

- **Include REFUTED + INCONCLUSIVE in priors.** A non-result is information ("this class of
  change is noisy/unreliable"). Filtering to CONFIRMED-only = survivorship bias.
- **Weight by `belief_score`** — a confident outcome informs the prior more than an
  inconclusive one.
- Future estimation needs two things from this store: **base rate** (distribution of
  measured lifts for the reference class) and **calibration** (signed error
  `predicted − measured`, e.g. "this team over-predicts activation ~2x").
- **v1 computes priors on-the-fly** by reference-class query — this is the "graph pays off
  at prediction #2" surface. The learned belief/decay model stays the deferred P2 platform
  track (no ML in v1).

## Eng design

### Drift detector

```
  Jira / GitHub webhook ─▶ receiver (Next route handler)
        │  verify secret · dedup on (source, provider_event_id)
        ▼
  transition_events (append-only)  ── canonical map ──▶ {DROPPED, SHIPPED, ACTIVE}
        │                                                   │
        │  LEVER_SHIPPED ─▶ set intervention date (enables resolution)
        │  LEVER_DROPPED ─▶ if action.is_lever AND decision has unresolved prediction
        ▼                       └─▶ assert-fact/ask-interpretation alert (idempotent per
  Vercel Cron reconciliation                                    (prediction, transition))
    poll causent-linked lever tickets; synthesize missing transitions (backstop dropped webhooks)
```

Per-source canonical map:
- **Jira:** Done + resolution Won't-Do/Won't-Fix → `LEVER_DROPPED`; removed from active
  sprint while not Done → `LEVER_DROPPED`; Done + Fixed/Done → `LEVER_SHIPPED`.
- **GitHub:** PR closed-unmerged / issue closed-not-planned → `LEVER_DROPPED`; PR merged →
  `LEVER_SHIPPED`.

**Push (webhooks) + poll (cron).** This formally reverses the v1 "no webhooks
(poll/backfill)" decision in `did-it-ship-did-it-work.md`: v1 was poll-only; drift needs
push for timeliness AND poll for completeness (a decision graph can't have holes). Boring
by default — no innovation token spent (Supabase tables, Vercel Cron, standard webhooks,
the ITS engine already live at `causent-engine`).

### Connectors

Backend-only (browser → Next route/Edge fn → Jira/GitHub; no client-side calls — no CORS,
no leaked creds). Basic-auth API token for the design partner; OAuth 3LO deferred to
multi-tenant. Mirror the existing `lib/ingest/*` pure-core + adapter + CLI pattern.
Provenance both directions: forward FK (`actions.external_ref`) + reverse (Jira issue
property `causent.decisionId` / GitHub `causent-decision-<id>` label + a remote issue
link). **Build ONE connector first** — whichever tracker the design partner uses; gate the
second on a second partner.

## Build phasing

1. **Foundations** — `decisions` + `decision_actions` + `predictions` +
   `prediction_revisions`; prediction-capture + mechanism-mapping UI; resolution readout
   reusing the live ITS engine. (Day-one artifact + resolution payoff, no external deps.)
2. **One connector** — Jira OR GitHub create/link with two-directional provenance.
3. **Drift detector LAST** — `transition_events` + webhooks + reconciliation + the
   assert-fact alert. **Gated** by the week-1 validation below.

## Risks, validation, success metrics

- **Load-bearing risk:** the whole loop rests on teams naming the mechanism and mapping the
  lever ticket. **Week-1 zero-code test:** take a real decision, ask the partner to name
  the mechanism and point at the ticket. 5-second answer → build. 15-minute argument → the
  argument IS the product. Shrug/can't-map → the drift signal has no substrate; hold the
  detector and rethink the signal.
- **Before shipping the drift detector:** replay the partner's last quarter of ticket
  transitions against the conservative taxonomy; ship the alert only if the false-positive
  count is near zero.
- **Success metrics (instrument from partner #1):** mechanism-mapping rate (substrate
  exists), resolution-return rate (the built-in retention event fires), alert-action rate
  vs muted (signal quality).

## Relationship to existing docs

- `did-it-ship-did-it-work.md` — the retrospective wedge, RETAINED as the data-rich
  on-ramp. Its v1 "no webhooks" decision is reversed here (see Eng design).
- `decision-graph.md` — the ITS belief model + causal-edge data model this builds on
  unchanged; this doc adds the upstream intent + prediction + transition layer.
- `security-and-auth.md` — auth (issue #5) is independent infrastructure, unaffected.

## Deferred (NOT in scope)

- OAuth 3LO multi-tenant connectors (basic-auth for the partner).
- Fuzzy matching of externally-created tickets to decisions (later workflow-exhaust capture).
- Reports as a scheduled analytics/research ritual (repurposed to signal-response only).
- Learned belief/decay model, cross-project pattern transfer (the P2 platform track).
