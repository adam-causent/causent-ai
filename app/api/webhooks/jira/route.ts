// Jira webhook receiver (#19). Unauthenticated by design (Jira can't carry a
// Causent session) — a shared secret IS the auth, so this route is excluded from
// the proxy guard. All logic is in lib/levers/jira-webhook (synthetic-tested);
// this adapter only pulls the raw body + the secret and picks the service-role
// client (a trusted server job, not a user request).
//
// Jira webhooks don't HMAC-sign by default, so the secret is configured as a
// custom header (x-causent-jira-secret) or a ?secret= query param on the webhook.
// LIVE requires a Jira automation/webhook + the basic-auth token (deferred human
// step); locally we prove it with synthetic payloads + JIRA_WEBHOOK_SECRET.

import { NextResponse } from "next/server";
import { getServiceRoleSupabase } from "@/lib/supabase-server";
import { processJiraWebhook } from "@/lib/levers/jira-webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.JIRA_WEBHOOK_SECRET;
  if (!secret) {
    // Not configured — refuse rather than accept unverifiable payloads.
    return NextResponse.json({ result: "not_configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const providedSecret =
    request.headers.get("x-causent-jira-secret") ??
    new URL(request.url).searchParams.get("secret");

  const outcome = await processJiraWebhook(getServiceRoleSupabase(), {
    rawBody,
    providedSecret,
    secret,
  });
  return NextResponse.json(
    { result: outcome.result, leverId: outcome.leverId ?? null },
    { status: outcome.status },
  );
}
