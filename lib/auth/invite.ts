// Invite tooling (#5). Adds a partner to the allowlist so their first Google
// login is accepted (enforce_allowlist hook) and provisioned onto the shared
// demo org as `viewer` (handle_new_user trigger). The Supabase client is
// INJECTED (like lib/ingest's store + lib/onboarding's commit) so this is
// unit-testable and stays importable outside the Next runtime.
//
// TWO allowlist layers must both include the partner (documented in the report):
//   1. this row in public.allowed_emails, and
//   2. the email added as a Google OAuth **test user** (consent screen stays in
//      Testing mode). This function does (1); (2) is a Google-console step.

import type { SupabaseClient } from "@supabase/supabase-js";

/** The shared design-partner org (seed_demo.py ORG = ca5e…d1). */
export const DEMO_ORG_ID = "ca5e0000-0000-0000-0000-0000000000d1";

export type InviteRole = "owner" | "admin" | "member" | "viewer";

export type InviteResult =
  | { ok: true; email: string; orgId: string; role: InviteRole }
  | { ok: false; error: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Upsert one allowlist invite. Emails are stored lowercased (the hook + trigger
 * compare lower(email)). Idempotent: re-inviting the same email updates the
 * org/role rather than erroring, so the CLI is safe to re-run.
 */
export async function inviteEmail(
  sb: SupabaseClient,
  params: { email: string; orgId?: string; role?: InviteRole },
): Promise<InviteResult> {
  const email = params.email.trim().toLowerCase();
  const orgId = params.orgId ?? DEMO_ORG_ID;
  const role = params.role ?? "viewer";
  if (!EMAIL_RE.test(email)) return { ok: false, error: `Not an email: ${params.email}` };

  const { error } = await sb
    .from("allowed_emails")
    .upsert({ email, org_id: orgId, role }, { onConflict: "email" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, email, orgId, role };
}
