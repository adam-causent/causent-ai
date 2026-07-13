// SERVER-ONLY Supabase clients. Never import from a Client Component ("use
// client") — this reads privileged env and must stay on the server. The runtime
// guard below turns an accidental client import into a loud error instead of a
// silent secret leak.
//
// Two clients, one seam (#5 — invite-only auth):
//
//   getServerSupabase()      — the DASHBOARD READ/WRITE path. In production it is
//     a per-request client built from the caller's Supabase session cookie
//     (@supabase/ssr createServerClient), running as `authenticated` so
//     has_scope_access() RLS gates every row by the user's membership. The
//     lib/data/* callers are UNCHANGED — they keep querying WHERE scope_id =
//     DEMO_SCOPE_ID, but now under the user's session (defense in depth: a
//     non-member gets zero rows). The service-role key never touches this path.
//
//   getServiceRoleSupabase() — the RLS-BYPASSING service-role client, for the
//     seed/provisioner, the invite CLI, GitHub ingestion backfill, and the
//     unauthenticated webhook + cron jobs (#16). NEVER the dashboard read path in
//     prod. Pinned scoping (DEMO_SCOPE_ID) is still what keeps these safe.
//
// LOCAL DEMO (CAUSENT_LOCAL_DEMO=1, never set in prod): there is no real Google
// login locally, so a session-scoped read would return zero rows and blank the
// demo. Under the flag, getServerSupabase() resolves the service-role client so
// /impact, /actions, /data-workshop, /onboarding keep rendering seed data. The
// flag is the documented escape hatch from the #5 runbook — the demo must never
// go blank.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

if (typeof window !== "undefined") {
  throw new Error(
    "lib/supabase-server.ts was imported in the browser. It is server-only " +
      "(reads privileged keys); import it only from Server Components, route " +
      "handlers, or server-side lib code.",
  );
}

/** True in the local demo (no real auth) — keep the RLS-bypass read path so the
 *  seeded demo renders. NEVER set CAUSENT_LOCAL_DEMO in production. */
export function isLocalDemo(): boolean {
  return process.env.CAUSENT_LOCAL_DEMO === "1";
}

function requireUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL in the server environment.");
  return url;
}

let serviceRoleCached: SupabaseClient | null = null;

/**
 * The service-role client (memoized). RLS-bypassing — use ONLY for the
 * seed/provisioner, invite CLI, ingestion backfill, and the unauthenticated
 * webhook/cron jobs. Not for dashboard reads in production.
 */
export function getServiceRoleSupabase(): SupabaseClient {
  if (serviceRoleCached) return serviceRoleCached;
  const url = requireUrl();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY in the server environment (.env.local).",
    );
  }
  serviceRoleCached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceRoleCached;
}

/**
 * The per-request dashboard client. In local demo → the service-role client
 * (seed renders with no login). Otherwise → an RLS-scoped client bound to the
 * caller's Supabase session cookie, so every read/write runs as `authenticated`
 * and RLS enforces the user's membership.
 *
 * Async because Next 16's cookies() is async. Callers `await getServerSupabase()`.
 */
export async function getServerSupabase(): Promise<SupabaseClient> {
  if (isLocalDemo()) return getServiceRoleSupabase();

  const url = requireUrl();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY in the server environment.");

  // Import lazily so non-request server contexts (the ingest CLI under tsx,
  // which never calls getServerSupabase) don't pull in next/headers.
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // In a Server Component render, setting cookies is unsupported and
        // throws — proxy.ts already refreshed the session, so swallow it. In a
        // Server Action / Route Handler this path persists the refreshed tokens.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          /* Server Component: proxy.ts handles refresh. */
        }
      },
    },
  });
}
