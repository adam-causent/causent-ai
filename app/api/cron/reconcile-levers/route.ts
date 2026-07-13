// Reconciliation cron (#16) — Vercel Cron backstop for dropped webhooks + the
// draft timeout. Unauthenticated route (excluded from the proxy guard), so it is
// protected by CRON_SECRET: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
// (configure the secret in the Vercel project). All logic is in
// lib/levers/reconcile (tested with a MOCK poller); this adapter picks the client,
// the poller (live only when GITHUB_TOKEN is set — else timeout-only), and scope.
//
// Schedule lives in vercel.json (crons). LIVE polling of a real repo is the
// credential-gated follow-up; the timeout sweep runs regardless.

import { NextResponse } from "next/server";
import { getServiceRoleSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID } from "@/lib/data/config";
import { reconcileLevers } from "@/lib/levers/reconcile";
import { createGitHubPoller, nullPoller } from "@/lib/connectors/github-poll";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.GITHUB_TOKEN;
  const poller = token ? createGitHubPoller(token) : nullPoller;
  const timeoutDays = Number(process.env.CAUSENT_LEVER_TIMEOUT_DAYS) || undefined;

  const out = await reconcileLevers(getServiceRoleSupabase(), poller, {
    scopeId: DEMO_SCOPE_ID,
    now: new Date(),
    timeoutDays,
  });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 500 });
  return NextResponse.json({ ...out.result, live_poll: Boolean(token) }, { status: 200 });
}
