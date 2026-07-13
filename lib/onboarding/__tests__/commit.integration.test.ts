// Integration gate for the funnel's commit path (C2/#15): declared-metric
// creation + the decision/prediction insert, against the LOCAL Supabase stack
// in a scratch tenant (created and torn down here — independent of the demo
// seed). Skips honestly when the stack isn't reachable.
//
// Scope model: the writes are made through a client pinned to the scratch
// workspace's scope_id, exactly the shape the server action uses with the
// session seam (lib/auth/session.ts). Tenant isolation itself is proven by
// the engine's RLS gate (engine/tests/test_rls_isolation.py, levers cases
// included); THIS gate proves the funnel writes land with the right scope,
// shape, and UNATTRIBUTED state.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { commitPrediction, declareMetric } from "../commit.ts";

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
const KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? ""
).trim();

// Scratch tenant (namespaced, teardown exact).
const ORG = "0b0a0000-0000-0000-0000-0000000000a0";
const PROJ = "0b0a0000-0000-0000-0000-0000000000a1";
const WS = "0b0a0000-0000-0000-0000-0000000000a2";

let sb: SupabaseClient | null = null;
let available = false;

async function teardown(client: SupabaseClient) {
  await client.from("orgs").delete().eq("org_id", ORG); // cascades the tenant
}

before(async () => {
  if (!URL || !KEY) return;
  sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const probe = await sb
    .from("workspaces")
    .select("workspace_id")
    .limit(1)
    .then((r) => r, () => ({ error: new Error("unreachable") }));
  if (probe.error) return;
  available = true;
  await teardown(sb);
  const org = await sb.from("orgs").insert({ org_id: ORG, name: "ONBOARDING_TEST_org" });
  assert.equal(org.error, null, org.error?.message);
  await sb.from("projects").insert({ project_id: PROJ, org_id: ORG, name: "p" });
  await sb.from("workspaces").insert({ workspace_id: WS, project_id: PROJ, name: "w" });
});

after(async () => {
  if (sb && available) await teardown(sb);
});

function gated(t: TestContext): boolean {
  if (!available) {
    t.skip("local Supabase not reachable — start it with `supabase start`");
    return false;
  }
  return true;
}

test("declareMetric creates exactly one declared row, then reuses it by name", async (t) => {
  if (!gated(t) || !sb) return;

  const first = await declareMetric(sb, WS, "  Expansion   Revenue ");
  assert.ok(!("error" in first), "error" in first ? first.error : "");
  assert.equal(first.reused, false);
  assert.equal(first.source, "declared");
  assert.equal(first.name, "Expansion Revenue"); // whitespace normalized
  assert.equal(first.hasObservations, false);

  // Same name, different case: REUSED — no duplicate row.
  const second = await declareMetric(sb, WS, "expansion revenue");
  assert.ok(!("error" in second));
  assert.equal(second.reused, true);
  assert.equal(second.metricId, first.metricId);

  const rows = await sb
    .from("metrics")
    .select("metric_id, source")
    .eq("scope_id", WS)
    .ilike("name", "expansion revenue");
  assert.equal(rows.error, null);
  assert.equal(rows.data?.length, 1, "exactly one metrics row for the declared name");
  assert.equal(rows.data?.[0].source, "declared");

  // Empty name is refused, not written.
  const refused = await declareMetric(sb, WS, "   ");
  assert.ok("error" in refused);
});

test("commitPrediction inserts decision + UNATTRIBUTED prediction in the scope", async (t) => {
  if (!gated(t) || !sb) return;

  const metric = await declareMetric(sb, WS, "Activation Rate (scratch)");
  assert.ok(!("error" in metric));

  // Blocked until the mechanism is named — and nothing is written.
  const blocked = await commitPrediction(sb, WS, {
    title: "Guided onboarding checklist",
    mechanismSummary: "   ",
    mechanismCategory: "activation",
    notes: [],
    metricId: metric.metricId,
    direction: "POSITIVE",
    magnitudePctMean: 4,
    resolutionDate: "2027-01-15",
  });
  assert.equal(blocked.ok, false);

  const res = await commitPrediction(sb, WS, {
    title: "Guided onboarding checklist",
    mechanismSummary: "A checklist walks new users to the aha moment faster.",
    mechanismCategory: "activation",
    notes: ["The checklist replaces the empty dashboard state."],
    metricId: metric.metricId,
    direction: "POSITIVE",
    magnitudePctMean: 4,
    resolutionDate: "2027-01-15",
  });
  assert.ok(res.ok, res.ok ? "" : res.errors.join("; "));

  const pred = await sb
    .from("predictions")
    .select(
      "scope_id, decision_id, metric_id, direction, magnitude_pct_mean, " +
        "resolution_date, resolved_verdict, resolved_at",
    )
    .eq("prediction_id", res.predictionId)
    .single();
  assert.equal(pred.error, null);
  const predRow = pred.data as unknown as {
    scope_id: string;
    metric_id: string;
    direction: string;
    magnitude_pct_mean: number;
    resolution_date: string;
    resolved_verdict: string | null;
    resolved_at: string | null;
  };
  assert.equal(predRow.scope_id, WS);
  assert.equal(predRow.metric_id, metric.metricId);
  assert.equal(predRow.direction, "POSITIVE");
  assert.equal(predRow.magnitude_pct_mean, 4);
  assert.equal(predRow.resolution_date, "2027-01-15");
  // UNATTRIBUTED state: unresolved, and NO lever rows exist for the decision.
  assert.equal(predRow.resolved_verdict, null);
  assert.equal(predRow.resolved_at, null);
  const levers = await sb
    .from("levers")
    .select("lever_id")
    .eq("decision_id", res.decisionId);
  assert.equal(levers.error, null);
  assert.equal(levers.data?.length, 0);

  const decision = await sb
    .from("decisions")
    .select("scope_id, title, rationale")
    .eq("decision_id", res.decisionId)
    .single();
  assert.equal(decision.error, null);
  assert.equal(decision.data?.scope_id, WS);
  const rationale = decision.data?.rationale as {
    content: Array<{ content: Array<{ text: string }> }>;
    meta: { mechanism_category: string };
  };
  assert.equal(rationale.meta.mechanism_category, "activation");
  assert.equal(rationale.content.length, 2); // mechanism + the answered question
});
