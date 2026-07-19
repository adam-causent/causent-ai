// Resolution cron (#18) — the scheduled trigger that resolves due predictions
// at their resolution_date. Unauthenticated route (excluded from the proxy
// guard), protected by CRON_SECRET exactly like reconcile-levers: Vercel Cron
// sends `Authorization: Bearer <CRON_SECRET>`.
//
// SCHEDULE (vercel.json): "0 15 * * *". Vercel crons are UTC ONLY — no local
// time, no DST. 15:00 UTC = 8am PDT (7am PST), so the daily resolve fires before
// a partner's morning rather than at 11pm the night before (which "0 6 * * *"
// actually meant). resolution_date comparisons in the runner are UTC too.
//
// The verdict machine lives in the Python engine (engine/persistence/resolve.py);
// this route NEVER re-implements resolution. It only picks HOW to reach it:
//
//   * PROD (serverless — no Python venv): POST the deployed resolution function
//     (project `causent-resolve`, scripts/deploy-resolve.sh) at CAUSENT_RESOLVE_URL
//     with the shared secret CAUSENT_RESOLVE_SECRET. This is the "port": the same
//     resolve_due_predictions sweep, reachable over HTTP.
//   * DEV (local venv present): shell out to the SAME runner the "Resolve now"
//     affordance uses (engine/persistence/run_resolution.py).
//
// Loud degradation (mirrors reconcile-levers): when neither the remote URL nor a
// local venv resolves anything, the response says so plainly — a plain `curl`
// tells the truth, not a green 200 that silently did nothing.

import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";

export const dynamic = "force-dynamic";
// The remote fn call is fast; the local spawn path wants Node runtime headroom.
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/** PROD path: POST the deployed resolution function. Returns null when it isn't
 *  configured (so the caller can fall back to the local runner in dev). */
async function resolveViaRemote(
  url: string,
  secret: string,
  today: string | undefined,
): Promise<NextResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-causent-resolve-secret": secret,
      },
      body: JSON.stringify(today ? { today } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "resolution function unreachable", resolver: "remote", detail: String(err) },
      { status: 502 },
    );
  }
  const body = await res.json().catch(() => ({ error: "non-JSON response from resolver" }));
  return NextResponse.json({ resolver: "remote", ...body }, { status: res.status });
}

/** DEV path: shell the Python runner (needs the local venv). */
async function runLocalResolution(): Promise<{ code: number | null; out: string }> {
  const engineDir = process.env.CAUSENT_ENGINE_DIR ?? path.join(process.cwd(), "engine");
  const python =
    process.env.CAUSENT_ENGINE_PYTHON ?? path.join(engineDir, ".venv", "bin", "python");
  const today = process.env.CAUSENT_DEMO_TODAY; // demo data lives in the past

  const args = [path.join("persistence", "run_resolution.py")];
  if (today) args.push("--today", today);

  return new Promise((resolve) => {
    const child = spawn(python, args, { cwd: engineDir });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: null, out: String(err) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const remoteUrl = process.env.CAUSENT_RESOLVE_URL;
  const remoteSecret = process.env.CAUSENT_RESOLVE_SECRET;
  const today = process.env.CAUSENT_DEMO_TODAY;

  // Prefer the deployed function whenever it's configured — the only path that
  // works in a serverless runtime.
  if (remoteUrl && remoteSecret) {
    return resolveViaRemote(remoteUrl, remoteSecret, today);
  }

  // No remote configured — fall back to the local runner (dev). On Vercel there
  // is no Python venv, so this fails loudly rather than pretending to resolve.
  const result = await runLocalResolution();
  if (result.code !== 0) {
    console.warn(
      "[cron/resolve] no CAUSENT_RESOLVE_URL and local runner failed — resolution " +
        "is degraded. Deploy causent-resolve (scripts/deploy-resolve.sh) and set " +
        "CAUSENT_RESOLVE_URL + CAUSENT_RESOLVE_SECRET on this project.",
    );
    return NextResponse.json(
      {
        error: "resolution runner failed",
        resolver: "local",
        hint: "set CAUSENT_RESOLVE_URL + CAUSENT_RESOLVE_SECRET to use the deployed function",
        detail: result.out.split("\n").slice(-4).join("\n"),
      },
      { status: 500 },
    );
  }
  const summary =
    result.out
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("RESULT:")) ?? "resolution sweep complete";
  return NextResponse.json({ ok: true, resolver: "local", summary }, { status: 200 });
}
