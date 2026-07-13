// DEPRECATED (#5). The bare `createClient` anon client that used to live here did
// not persist a cookie-based session, so it could not participate in the
// @supabase/ssr auth flow. It is unused. Use instead:
//   - lib/supabase-browser.ts  (getBrowserSupabase)  — Client Components / login
//   - lib/supabase-server.ts   (getServerSupabase)   — RLS-scoped server reads
//
// Kept as a thin re-export so any stray import resolves to the SSR browser
// client rather than silently constructing a sessionless one.

export { getBrowserSupabase } from "@/lib/supabase-browser";
