# Causent Security & Auth

Status: LIVING DOCUMENT (v1 decisions locked 2026-07-02)
Owner: founder
Related: `docs/designs/did-it-ship-did-it-work.md` (PRD), `docs/designs/decision-graph.md` (data model / RBAC tables)

Causent is trust-first and handles two classes of sensitive customer data: **private
repository metadata** (PRs, issues, timestamps) and **business metrics** (revenue,
conversion, retention). Security is a first-class deliverable, not polish.

## 1. Authentication (v1 — multi-provider)

**Supersedes the office-hours PRD's "GitHub OAuth (single provider)."** Login identity
is **decoupled from the GitHub data connection** so non-engineer teammates (PMs,
analysts — the expansion ICP) can use the product.

Supabase Auth providers enabled in v1:
- **Email** — magic link + password.
- **Google OAuth** — social login (the founder's account is Gmail; common for the ICP).
- **GitHub OAuth** — still offered as a login option AND used to authorize repo read.
- **SSO (SAML / enterprise OIDC)** — available via Supabase for org-level SSO; enabled
  per-org for design partners who require it.

**Decoupling (important):** GitHub is now a **connected data source**, not the only
identity. A user can log in with email/Google/SSO and *separately* "Connect GitHub" in
the Actions & Decisions tab to authorize repo read. This removes the barrier for
non-code users and keeps the repo token scoped to the connection, not the session.

```
LOGIN                          DATA CONNECTIONS (separate, per-user or per-workspace)
 ├─ email (magic link/pw)       ├─ GitHub (repo read: PRs, issues, timestamps)
 ├─ Google OAuth        ─────▶  ├─ CSV upload (metrics)
 ├─ GitHub OAuth                └─ Postgres connector (guarded; later)
 └─ SAML/OIDC SSO (per-org)
```

## 2. Authorization (RBAC over the scope hierarchy)

Access control rides the **org → project → workspace** hierarchy (see
`decision-graph.md`). The `memberships` table (user × scope × role) is what makes RLS
enforceable.

| Role | Can |
|---|---|
| **owner** | billing, delete org/project, manage members, everything below |
| **admin** | manage data + connections + members (not billing/delete) |
| **member** | create/edit actions, metrics, decision rationale; run readouts |
| **viewer** | read-only |

Grants **inherit downward**: an org admin admins every project/workspace; a
workspace-scoped viewer sees only that workspace. RLS resolves access by checking for a
membership whose scope covers the row's `scope_id` at a sufficient role.

## 3. Row-Level Security (RLS)

- **Every table** has RLS enabled, scoped via `memberships` (no table is world-readable).
- Policies key off `auth.uid()` → membership covering the row's `scope_id`.
- The **causal engine (Vercel Python) never bypasses RLS**: it is stateless compute that
  receives the already-RLS-scoped series as data and holds **no DB service-role key**.
  (Review finding S3 / task T-RLS — P1.)

## 4. Secrets & credential management

All secrets live in **Supabase Vault** (encrypted at rest), never in plaintext rows or
client-visible env:

| Secret | Store | Notes |
|---|---|---|
| GitHub PAT/OAuth token | Vault, per connection | encrypt at rest (S1/T-TOK, P1); refresh + revocation handling |
| Warehouse connector creds | Vault | read-only role; SSRF-guarded host (S2/T-CONN) |
| Causal engine shared secret | env (server-only) | rotatable; per-caller rate limit (ET1/ET17) |
| Anthropic API key | env (server-only) | never client-exposed |

**Token lifecycle:** on GitHub 401/403 (revoked/expired/rate-limited) the UI prompts
"reconnect GitHub"; tokens are re-authorized, not silently retried. Rotation policy: TBD
(open question below).

## 5. Attack surface & threat model (from the reviews)

| Threat | Mitigation | Status |
|---|---|---|
| Cross-tenant data access (IDOR) | RLS via memberships; scope on every row | T-RLS (P1) + ET7 cross-tenant test |
| Engine endpoint DoS / compute abuse | shared-secret + input & action-count cap + rate limit | ET1/ET16/ET17 |
| SSRF via connector connection string | host allowlist, block private/link-local/RFC1918, read-only | S2/T-CONN |
| LLM prompt injection (malicious PR text) | GitHub text treated as untrusted; summary templated from numbers (LLM can't invent a causal claim) | S4/T-PI + ET9 eval |
| Service-role RLS bypass | engine holds no DB creds; app fetches scoped data | S3/T-RLS (P1) |
| Secret leakage | Vault at rest; server-only env; rotation | S1/T-TOK |
| Overclaim (trust attack) | readout is "estimated, not proven"; placebo falsification | design + E3 |

## 6. Data classification & audit

- **Sensitive:** GitHub repo metadata, business-metric values, warehouse creds, tokens.
- **Audit trail:** `evidence_objects` is append-only; the **AI Action Log** records every
  mutation (human or agent) with an authorship token. Auth events (login, connect,
  member change) logged via Supabase.

## 7. v1 security task list

- [ ] **SEC1 (P1)** — `memberships` table + RLS policies keyed off it (every table). *(new — closes the hierarchy access-control gap)*
- [ ] **SEC2 (P1)** — Multi-provider Supabase Auth (email + Google + GitHub + SSO), login decoupled from the GitHub data connection.
- [ ] **SEC3 (P1)** — Encrypt GitHub token at rest in Vault; 401/403 → reconnect flow (= T-TOK).
- [ ] **SEC4 (P1)** — RLS cross-tenant test: user A cannot read user B's data (= ET7).
- [ ] **SEC5 (P2)** — Connector SSRF guardrails (= T-CONN).
- [ ] **SEC6 (P2)** — Engine endpoint shared-secret + rate limit + rotation (= ET1/ET17).
- [ ] **SEC7 (P2)** — GitHub text untrusted in LLM prompts (= T-PI).

## 8. Open questions

- **Token rotation policy** for GitHub / connector creds (interval vs on-demand).
- **SSO depth for v1:** enable SAML for the first partner if asked, or defer to when a
  partner requires it? (Leaning: build the multi-provider seam now, turn on SAML per-org
  on demand.)
- **Invite flow / member management UI** — where does it live (Settings)? Not yet designed.
- **Personal vs org GitHub apps** — v1 uses a PAT/OAuth token for the first partner; the
  GitHub App (publish/approval) is deferred (PRD).

## Change log
- 2026-07-02 — Initial. Multi-provider auth (adds email/Google/SSO, decouples GitHub as a
  data source); memberships/RBAC over the scope hierarchy; consolidated the review's
  security findings into a threat model + task list.
