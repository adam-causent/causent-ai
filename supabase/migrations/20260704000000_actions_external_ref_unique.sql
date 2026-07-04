-- ============================================================================
-- GitHub ingestion — make external_ref dedup enforceable (Phase C).
-- ============================================================================
-- The capped GitHub backfill (lib/ingest/github.ts) is idempotent: it dedups
-- incoming merged-PR / resolved-issue rows on a stable external_ref like
-- "github:pr:8107" before inserting. This partial unique index is the DB-level
-- BACKSTOP for that guarantee — a concurrent double-ingest can no longer create
-- two `actions` rows for the same repo event; the second insert conflicts and the
-- store (lib/ingest/github-store.ts) treats the unique-violation as a no-op.
--
-- Scoped per workspace (scope_id, external_ref) because two workspaces may each
-- track their own "github:pr:1". Partial (WHERE external_ref IS NOT NULL) so
-- MANUAL actions, which carry no external_ref, are unaffected.
create unique index actions_scope_external_ref_uniq
  on public.actions (scope_id, external_ref)
  where external_ref is not null;
