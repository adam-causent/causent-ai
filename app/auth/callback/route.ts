// OAuth callback (#5). Google redirects back here with a `code`; we exchange it
// for a Supabase session (setting the auth cookies) and send the user to
// /impact. Two failure paths, both landing on /login with a friendly note:
//   - Google/Supabase returned an `error` (e.g. the Before-User-Created hook
//     rejected a non-allowlisted email) → /login?error=not_allowed.
//   - No code / exchange failed → /login?error=not_allowed as well (invite-only,
//     so any failure reads as "not allowed" to the partner).
//
// Route Handlers CAN set cookies (unlike Server Component render), so this is
// where exchangeCodeForSession persists the session. Never cached.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");

  const denied = NextResponse.redirect(`${origin}/login?error=not_allowed`);

  // GoTrue surfaces a hook rejection as an error param on the redirect.
  if (oauthError || !code) return denied;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return denied;

  const cookieStore = await cookies();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return denied;

  return NextResponse.redirect(`${origin}/impact`);
}
