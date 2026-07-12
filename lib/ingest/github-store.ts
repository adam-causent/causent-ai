// SERVER-ONLY Supabase-backed ActionStore — persists ingested action rows into
// public.actions, deduped on external_ref. The pure pipeline (lib/ingest/github.ts)
// stays DB-free; this is the only ingestion file that touches Postgres.
//
// Idempotency is enforced two ways that agree:
//   1. Application dedup: existingRefs() reports which external_refs already exist,
//      so upsertActions() only inserts fresh rows.
//   2. DB backstop: the partial unique index actions_scope_external_ref_uniq
//      (supabase/migrations/20260704000000_actions_external_ref_unique.sql) makes a
//      concurrent double-insert a no-op instead of a duplicate.
//
// Ingestion is a backfill JOB, not a dashboard read, so it uses the explicit
// service-role client (getServiceRoleSupabase — #5 renamed the RLS-bypass client
// out of the getServerSupabase read path). It already writes scope_id per row;
// when ingestion later runs under a per-job RLS identity this store is unchanged.

import { getServiceRoleSupabase } from "@/lib/supabase-server";
import type { ActionRow, ActionStore } from "@/lib/ingest/github";

/** Postgres unique-violation SQLSTATE — a lost race against the backstop index. */
const UNIQUE_VIOLATION = "23505";

export function createSupabaseActionStore(): ActionStore {
  const sb = getServiceRoleSupabase();
  return {
    async existingRefs(scopeId: string, refs: string[]): Promise<Set<string>> {
      if (refs.length === 0) return new Set();
      const { data, error } = await sb
        .from("actions")
        .select("external_ref")
        .eq("scope_id", scopeId)
        .in("external_ref", refs);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ external_ref: string | null }>;
      return new Set(rows.map((r) => r.external_ref).filter((r): r is string => r != null));
    },

    async insert(rows: ActionRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      const { data, error } = await sb.from("actions").insert(rows).select("action_id");
      if (error) {
        // A concurrent ingest already inserted the same external_ref: the backstop
        // index rejected it. That is success for an idempotent backfill, not an error.
        if (error.code === UNIQUE_VIOLATION) return 0;
        throw error;
      }
      return (data ?? []).length;
    },
  };
}
