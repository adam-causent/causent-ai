// Resolution cron (#18) — the scheduled trigger that resolves due predictions
// at their resolution_date. Unauthenticated route (excluded from the proxy
// guard), protected by CRON_SECRET exactly like reconcile-levers: Vercel Cron
// sends `Authorization: Bearer <CRON_SECRET>`.
//
// SCHEDULE (vercel.json): "0 15 * * *". Vercel crons are UTC ONLY — no local
// time, no DST. 15:00 UTC = 8am PDT (7am PST), so the daily resolve fires before
// a partner's morning rather than at 11pm the night before (which "0 6 * * *"
// actually meant). resolution_date comparisons in the runner are UTC too; keep
// the runner compares against date.today() (server-local, = UTC on Vercel's
// runtime), so it aligns with the UTC cron — but a non-UTC host would drift the
// boundary and yield off-by-one resolutions.
//
// It shells out to the SAME runner the "Resolve now" dev affordance uses
// (engine/persistence/run_resolution.py) — the verdict machine lives in the
// engine; this adapter only picks the interpreter, cwd, and the demo "today"
// override, then reports the sweep result. Nothing here re-implements
// resolution. Schedule lives in vercel.json (crons).
//
// Prod note: the standing seam is the sweep. Live scheduling in a serverless
// runtime (which has no Python venv) is the credential/infra follow-up; locally
// and in the runner's own environment this resolves the due predictions.

import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";

export const dynamic = "force-dynamic";
// Resolution shells a Python runner; give it Node runtime headroom.
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runDueResolution(): Promise<{ code: number | null; out: string }> {
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

  const result = await runDueResolution();
  if (result.code !== 0) {
    return NextResponse.json(
      { error: "resolution runner failed", detail: result.out.split("\n").slice(-4).join("\n") },
      { status: 500 },
    );
  }
  // Surface the runner's RESULT summary line to the caller.
  const summary =
    result.out
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("RESULT:")) ?? "resolution sweep complete";
  return NextResponse.json({ ok: true, summary }, { status: 200 });
}
