// Proxy (Next.js 16 renamed Middleware → Proxy; same runtime, Node.js default).
// Two jobs for #5 invite-only auth:
//
//   1. Refresh the Supabase session on every matched request (@supabase/ssr):
//      read the auth cookies off the request, let supabase.auth.getUser() rotate
//      them if needed, and write any refreshed cookies onto the response. Without
//      this, server reads would run with a stale/expired token.
//   2. Guard the app routes: an unauthenticated request to a protected page
//      (the dashboard tabs + onboarding) is redirected to /login. Public paths —
//      /login, /auth/* (the OAuth callback), /api/* (webhooks + cron are
//      unauthenticated by design, #16), and static assets — are never guarded.
//
// LOCAL DEMO: CAUSENT_LOCAL_DEMO=1 disables the redirect so the seeded demo stays
// open with no real Google login (the read path also falls back to service-role;
// see lib/supabase-server.ts). Flip the flag off to exercise the real guard.
//
// Defense-in-depth note (from the Next docs): a proxy guard is an OPTIMISTIC
// check, not the authorization boundary. The real boundary is Postgres RLS on
// every table (has_scope_access), enforced no matter how a request arrives.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Path prefixes that are public — never redirected to /login. */
const PUBLIC_PREFIXES = ["/login", "/auth", "/api"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // Start with a pass-through response we can attach refreshed cookies to.
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase env is absent (shouldn't happen in a configured deploy) skip the
  // session dance rather than throw and 500 every request.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // IMPORTANT: getUser() (not getSession()) — it revalidates the token with the
  // Auth server, which is what actually refreshes an expired session cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Local demo: session refreshed, but never redirect — keep the seed open.
  if (process.env.CAUSENT_LOCAL_DEMO === "1") return response;

  // Public paths are never guarded (webhooks/cron/login/callback + static).
  if (isPublicPath(pathname)) return response;

  // Protected app route with no session → send to login.
  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Run on everything EXCEPT Next internals, static image/asset files, and the
  // unauthenticated #16 webhook + cron routes (they must never touch the session
  // refresh or the guard). Auth logic for the remaining paths lives in proxy().
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|api/webhooks|api/cron|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)",
  ],
};
