// Integration gate for resolution_date → scorecard (C5/#18): reads the DEMO
// scope's resolved predictions (seeded + resolved through the REAL verdict
// machine by seed_demo.py) and asserts each verdict class shapes into an honest
// scorecard surface — CONFIRMED shows predicted-vs-measured, UNMEASURABLE_NO_
// METRIC routes to the connect/self-report surface, GATHERING to the not-yet
// surface, and NONE throw. Skips honestly when the demo seed isn't present.
//
// This is the read side of the loop: seed_demo.py runs resolve.py; this proves
// the app-side shaping (lib/scorecard.ts) reads that output faithfully.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, test, type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { shapeScorecard, type ResolutionTuple } from "../scorecard.ts";
import type { PredictionDirection, PredictionVerdict } from "../types.ts";

// The demo workspace (matches lib/data/config DEMO_SCOPE_ID + seed_demo SCOPE).
const DEMO_SCOPE_ID = "ca5e0000-0000-0000-0000-0000000000d3";

function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const env = loadEnvLocal();
const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

type PredRow = {
  direction: PredictionDirection;
  magnitude_pct_mean: number;
  resolved_verdict: PredictionVerdict | null;
  resolution_tuple: ResolutionTuple;
};

let sb: SupabaseClient | null = null;
let rows: PredRow[] = [];
let seeded = false;

before(async () => {
  if (!URL || !KEY) return;
  sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const res = await sb
    .from("predictions")
    .select("direction, magnitude_pct_mean, resolved_verdict, resolution_tuple")
    .eq("scope_id", DEMO_SCOPE_ID)
    .not("resolved_verdict", "is", null)
    .then((r) => r, () => ({ data: null, error: new Error("unreachable") }));
  if (res.error || !res.data) return;
  rows = res.data as unknown as PredRow[];
  seeded = rows.length > 0;
});

function gated(t: TestContext): boolean {
  if (!seeded) {
    t.skip("demo seed not present — run engine/persistence/seed_demo.py");
    return false;
  }
  return true;
}

test("every seeded resolved verdict class shapes without throwing", (t) => {
  if (!gated(t)) return;
  for (const row of rows) {
    const sc = shapeScorecard({
      verdict: row.resolved_verdict!,
      committedDirection: row.direction,
      committedMagnitudePct: row.magnitude_pct_mean,
      tuple: row.resolution_tuple,
    });
    assert.equal(sc.verdict, row.resolved_verdict);
    // The predicted side is ALWAYS present — the human commitment on the record.
    assert.equal(sc.predicted.magnitudePct, row.magnitude_pct_mean);
  }
});

test("CONFIRMED shows a measured %-of-mean number", (t) => {
  if (!gated(t)) return;
  const confirmed = rows.find((r) => r.resolved_verdict === "CONFIRMED");
  assert.ok(confirmed, "seed exercises CONFIRMED");
  const sc = shapeScorecard({
    verdict: "CONFIRMED",
    committedDirection: confirmed!.direction,
    committedMagnitudePct: confirmed!.magnitude_pct_mean,
    tuple: confirmed!.resolution_tuple,
  });
  assert.equal(sc.kind, "measured");
  assert.ok(sc.measured && sc.measured.pct !== null, "CONFIRMED carries a measured pct");
});

test("UNMEASURABLE_NO_METRIC routes to the connect/self-report surface", (t) => {
  if (!gated(t)) return;
  const unmeasurable = rows.find((r) => r.resolved_verdict === "UNMEASURABLE_NO_METRIC");
  assert.ok(unmeasurable, "seed exercises UNMEASURABLE_NO_METRIC");
  const sc = shapeScorecard({
    verdict: "UNMEASURABLE_NO_METRIC",
    committedDirection: unmeasurable!.direction,
    committedMagnitudePct: unmeasurable!.magnitude_pct_mean,
    tuple: unmeasurable!.resolution_tuple,
  });
  assert.equal(sc.kind, "unmeasurable");
  assert.equal(sc.measured, null); // never a fabricated readout
});

test("GATHERING routes to the not-yet surface (no hard resolve)", (t) => {
  if (!gated(t)) return;
  const gathering = rows.find((r) => r.resolved_verdict === "GATHERING");
  assert.ok(gathering, "seed exercises GATHERING");
  const sc = shapeScorecard({
    verdict: "GATHERING",
    committedDirection: gathering!.direction,
    committedMagnitudePct: gathering!.magnitude_pct_mean,
    tuple: gathering!.resolution_tuple,
  });
  assert.equal(sc.kind, "gathering");
  assert.equal(sc.measured, null);
});
