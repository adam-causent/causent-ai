// Browser-side Supabase client (@supabase/ssr). Reads only the PUBLIC anon key,
// so it is safe in a Client Component. Used by the login page to kick off the
// Google OAuth redirect; the session cookie it establishes is then read/refreshed
// server-side by proxy.ts + the RLS-scoped server client (lib/supabase-server.ts).
//
// createBrowserClient (unlike the bare createClient in the old lib/supabase.ts)
// persists the session in cookies the server can see — the whole point of the
// SSR split.

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** The memoized browser client (anon key only). */
export function getBrowserSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  cached = createBrowserClient(url, anonKey);
  return cached;
}
