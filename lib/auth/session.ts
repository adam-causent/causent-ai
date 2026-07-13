// The dev-session seam (cold-start C2/#15, agreed scope for the open #5).
//
// Auth itself is issue #5 (invite-only Google OAuth). Until it lands, THIS is
// the single place the app resolves "who is here and which workspace do they
// act in": it returns the demo workspace, matching how the /actions pages
// resolve scope (lib/data/config.ts DEMO_SCOPE_ID + the pinned service-role
// client). When #5 lands, getSession() swaps to reading the Supabase Auth
// session (via @supabase/ssr) and the funnel's server actions do not change —
// they keep calling getSession() and scoping every write to session.workspaceId.

import "server-only";

import { DEMO_SCOPE_ID } from "@/lib/data/config";

export type CausentSession = {
  /** The workspace every funnel write is scoped to. */
  workspaceId: string;
  /** null until #5 lands — committed_by stays unset on demo writes. */
  userId: string | null;
};

/** The current session. Demo: the seeded workspace, no user identity. */
export async function getSession(): Promise<CausentSession> {
  // TODO(#5): read the Supabase Auth session cookie here (createServerClient
  // from @supabase/ssr) and resolve the workspace from the user's membership.
  return { workspaceId: DEMO_SCOPE_ID, userId: null };
}
