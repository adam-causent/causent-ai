// Invite CLI (#5) — thin runner over lib/auth/invite.ts. Service-role only (the
// allowed_emails table is default-deny to `authenticated`), so it uses the
// explicit service-role client and must run with the react-server condition
// because lib/supabase-server imports `server-only`:
//
//   NODE_OPTIONS="--conditions react-server" \
//     npx tsx scripts/invite.ts partner@company.com [--role viewer] [--org <uuid>]
//
// Then add the SAME email as a Google OAuth test user (consent screen in Testing
// mode). See docs/OVERNIGHT_REPORT_5.md → PRODUCTION SETUP REQUIRED.

import { getServiceRoleSupabase } from "@/lib/supabase-server";
import { inviteEmail, type InviteRole } from "@/lib/auth/invite";

function parse(argv: string[]): { email?: string; role?: InviteRole; org?: string } {
  const out: { email?: string; role?: InviteRole; org?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") out.role = argv[++i] as InviteRole;
    else if (a === "--org") out.org = argv[++i];
    else if (!a.startsWith("--")) out.email = a;
  }
  return out;
}

export async function runInvite(argv: string[]): Promise<void> {
  const { email, role, org } = parse(argv);
  if (!email) {
    console.error("usage: invite.ts <email> [--role viewer|member|admin|owner] [--org <uuid>]");
    process.exit(2);
  }
  const result = await inviteEmail(getServiceRoleSupabase(), { email, role, orgId: org });
  if (!result.ok) {
    console.error(`invite failed: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `invited ${result.email} → org ${result.orgId} as ${result.role}.\n` +
      `Next: add ${result.email} as a Google OAuth test user (consent screen, Testing mode).`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runInvite(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
