// SERVER-ONLY Supabase client. Never import this from a Client Component ("use
// client") — it reads privileged env (the service-role key) and must stay on the
// server. The runtime guard below turns an accidental client import into a loud
// error instead of a silent secret leak.
//
// For the v1 demo this client uses SUPABASE_SERVICE_ROLE_KEY, which BYPASSES RLS.
// That is acceptable only because every read is already pinned to the single demo
// workspace (see lib/data/config.ts DEMO_SCOPE_ID). It is structured so the real,
// RLS-scoped, per-request client is a drop-in replacement:
//
//   TODO(auth): replace getServerSupabase() with a per-request client built from
//   the caller's Supabase session cookie via @supabase/ssr's createServerClient
//   (already a dependency). That client runs as `authenticated`, so has_scope_access()
//   RLS gates every row — the service role and DEMO_SCOPE_ID pin both go away, and
//   the scope comes from the user's membership instead. The lib/data/* callers do not
//   change: they keep calling getServerSupabase() and querying the same tables.
//
//   Example of the drop-in (post-auth):
//     import { cookies } from "next/headers";
//     import { createServerClient } from "@supabase/ssr";
//     export async function getServerSupabase() {
//       const cookieStore = await cookies();
//       return createServerClient(URL, ANON_KEY, { cookies: { ... } });
//     }

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

if (typeof window !== "undefined") {
  throw new Error(
    "lib/supabase-server.ts was imported in the browser. It is server-only " +
      "(reads the service-role key); import it only from Server Components, " +
      "route handlers, or server-side lib code.",
  );
}

let cached: SupabaseClient | null = null;

/**
 * The server-side Supabase client (memoized per server process).
 *
 * v1: service-role, RLS-bypassing — safe only because lib/data/* pins every query
 * to DEMO_SCOPE_ID. See the file header for the RLS-scoped drop-in.
 */
export function getServerSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the " +
        "server environment (.env.local).",
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
