// The session seam (#5 landed here). The single place the app resolves "who is
// here and which workspace do they act in". Both funnel and dashboard writes
// scope to session.workspaceId — unchanged callers.
//
// Design-partner demo model: ONE shared tenant. Invited partners are provisioned
// onto the seeded org (handle_new_user → org-level membership on ca5e…d1), so
// every authenticated partner acts in the same seeded workspace (DEMO_SCOPE_ID).
// RLS still gates them: a stranger with no membership reads/writes zero rows.
// (Per-partner tenants are SEC2, deferred — see the #5 Out of Scope.)
//
//   - Local demo (CAUSENT_LOCAL_DEMO=1): no real login → { DEMO_SCOPE_ID, null }.
//   - Production: reads the authenticated Supabase user for committed_by; the
//     workspace stays the shared demo scope.

import "server-only";

import { DEMO_SCOPE_ID } from "@/lib/data/config";
import { getServerSupabase, isLocalDemo } from "@/lib/supabase-server";

export type CausentSession = {
  /** The workspace every write is scoped to (shared demo tenant in v1). */
  workspaceId: string;
  /** The authenticated user id (populates committed_by); null in local demo. */
  userId: string | null;
};

/** The current session. */
export async function getSession(): Promise<CausentSession> {
  if (isLocalDemo()) {
    return { workspaceId: DEMO_SCOPE_ID, userId: null };
  }
  const sb = await getServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { workspaceId: DEMO_SCOPE_ID, userId: user?.id ?? null };
}
