"use client";

// The invite-only login screen (#5). One action: "Continue with Google", which
// hands off to Supabase's OAuth flow. On return the /auth/callback route
// exchanges the code for a session and redirects to /impact. If the email is not
// on the allowlist, the Before-User-Created hook rejects the signup and the
// callback bounces here with ?error=not_allowed → the friendly note below.
//
// Google is the ONLY provider for the design-partner demo (see
// docs/designs/security-and-auth.md; full multi-provider is SEC2, deferred).

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { Logo } from "@/components/shell/Logo";

function LoginCard() {
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rejected = params.get("error") === "not_allowed";

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserSupabase();
      const redirectTo = `${window.location.origin}/auth/callback`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });
      if (error) {
        setError(error.message);
        setBusy(false);
      }
      // On success the browser navigates away to Google; no further work here.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
      <h1 className="text-lg font-semibold text-[var(--text)]">Sign in to Causent</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Causent is invite-only during the design-partner preview.
      </p>

      {rejected && (
        <div className="mt-4 rounded-lg border border-[var(--neg)]/30 bg-[var(--neg)]/5 px-3 py-2 text-sm text-[var(--neg)]">
          That Google account isn’t on the invite list yet. Ask your Causent
          contact for access.
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-[var(--neg)]/30 bg-[var(--neg)]/5 px-3 py-2 text-sm text-[var(--neg)]">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-strong)] bg-white px-4 py-2.5 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--bg)] disabled:opacity-60"
      >
        <GoogleMark />
        {busy ? "Redirecting…" : "Continue with Google"}
      </button>

      <p className="mt-6 text-xs text-[var(--text-subtle)]">
        By continuing you agree to Causent’s preview terms. We only read what you
        connect.
      </p>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)]">
      <header className="flex h-14 items-center border-b border-[var(--border)] bg-[var(--surface)] px-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-4">
        <Suspense>
          <LoginCard />
        </Suspense>
      </main>
    </div>
  );
}
