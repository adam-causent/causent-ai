// GitHub webhook receiver (#16). Unauthenticated by design (GitHub can't carry a
// Causent session) — the HMAC signature IS the auth, so this route is excluded
// from the proxy guard. All logic is in lib/levers/webhook (synthetic-tested);
// this adapter only pulls the raw body + headers and picks the service-role
// client (a trusted server job, not a user request).
//
// LIVE requires the GitHub App + webhook secret (deferred human step). Locally we
// prove it with synthetic payloads signed with GITHUB_WEBHOOK_SECRET.

import { NextResponse } from "next/server";
import { getServiceRoleSupabase } from "@/lib/supabase-server";
import { processIssueWebhook } from "@/lib/levers/webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Not configured — refuse rather than accept unverifiable payloads.
    return NextResponse.json({ result: "not_configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const deliveryId = request.headers.get("x-github-delivery");
  const eventType = request.headers.get("x-github-event");

  // We only act on `issues` events; ping/others verify + 200 without work.
  if (eventType && eventType !== "issues") {
    return NextResponse.json({ result: `ignored_event_${eventType}` }, { status: 200 });
  }

  const outcome = await processIssueWebhook(getServiceRoleSupabase(), {
    rawBody,
    signature,
    deliveryId,
    secret,
  });
  return NextResponse.json(
    { result: outcome.result, leverId: outcome.leverId ?? null },
    { status: outcome.status },
  );
}
