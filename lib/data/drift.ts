// getDriftByPrediction() — compute-on-read baseline drift for the scope's
// unresolved predictions, by shelling out to the engine (persistence/read_drift.py)
// exactly like the "Resolve now" affordance shells out to run_resolution.py. The
// detector is Python (it reuses segmented_ols — no parallel stats path), so the
// read crosses the same bridge the rest of the engine does.
//
// Defensive by construction: on ANY failure — no Python toolchain (e.g. a deploy
// without the engine venv), a timeout, a non-zero exit, unparseable output — this
// returns an EMPTY map and the page renders with no notice. Drift is a local/demo
// depth signal; it must never white-screen a tab (mirrors loadDashboardData's
// seed fallback).

import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { cache } from "react";
import type { DriftReadout } from "@/lib/types";

// One subprocess per /actions render (React-cached per request). Killed after this
// budget so a hung engine can never hang the page.
const TIMEOUT_MS = 15_000;

export const getDriftByPrediction = cache(async function getDriftByPrediction(): Promise<
  Map<string, DriftReadout>
> {
  const engineDir = process.env.CAUSENT_ENGINE_DIR ?? path.join(process.cwd(), "engine");
  const python =
    process.env.CAUSENT_ENGINE_PYTHON ?? path.join(engineDir, ".venv", "bin", "python");
  const args = [path.join("persistence", "read_drift.py")];

  const raw = await new Promise<string | null>((resolve) => {
    let out = "";
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(python, args, { cwd: engineDir });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => done(null)); // spawn failed (no python) — no notice
    child.on("close", (code) => done(code === 0 ? out : null));
  });

  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Record<string, DriftReadout>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
});
