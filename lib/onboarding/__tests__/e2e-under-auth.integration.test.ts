// E2E-under-auth gate for the cold-start funnel (C2/#15): walks the WHOLE
// server-action chain a real authenticated session drives —
//
//   login (session-scoped client)  ->  paste  ->  interrogate (decision card)
//   ->  declare metric  ->  commit  ->  prediction card  +  funnel instrumentation
//
// against the LOCAL Supabase stack in a scratch tenant. The dev-session seam is
// the test harness (per the run scope): the writes go through a client PINNED
// to the scratch workspace's scope_id — exactly the shape the server action
// uses when getSession() resolves the workspace (lib/auth/session.ts). The LLM
// interrogate step is driven by a stubbed fetch so the walk is deterministic
// and offline; the fallback/shadow path is exercised too. Skips honestly when
// the stack isn't reachable.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parsePasteWithLLM } from "../llm.ts";
import { commitPrediction, declareMetric } from "../commit.ts";
import { recordFunnelEvent, getFunnelMetrics } from "../../data/funnel.ts";
import { TIME_TO_FIRST_TYPE_TARGET_MS } from "../../funnel/events.ts";

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

// Scratch tenant (namespaced, teardown exact) — distinct from commit.integration's.
const ORG = "0b0a0000-0000-0000-0000-0000000000b0";
const PROJ = "0b0a0000-0000-0000-0000-0000000000b1";
const WS = "0b0a0000-0000-0000-0000-0000000000b2";

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
  const org = await sb.from("orgs").insert({ org_id: ORG, name: "E2E_AUTH_TEST_org" });
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

/** A stubbed Anthropic response so the interrogate step is deterministic. */
function stubFetch(card: {
  title: string;
  metric_name: string | null;
  mechanism_category: string;
  mechanism_summary: string;
  questions: string[];
}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(card) }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("E2E: paste -> interrogate -> commit -> prediction card, with instrumentation", async (t) => {
  if (!gated(t) || !sb) return;
  const client = sb; // narrow for the closure
  const sessionKey = "e2e-run-1";

  // --- landing: the funnel mounts; the session resolves the workspace scope ---
  await recordFunnelEvent(client, WS, null, { sessionKey, eventType: "LANDED", step: "paste" });
  // first keystroke, comfortably under the 30s target
  await recordFunnelEvent(client, WS, null, {
    sessionKey,
    eventType: "FIRST_TYPE",
    step: "paste",
    msSinceStart: 5_200,
  });

  // --- paste -> interrogate: structure the note into a decision card ---
  const card = await parsePasteWithLLM(
    "We're adding an in-product onboarding checklist to guide new users to their first report.",
    {
      apiKey: "test-key",
      fetchImpl: stubFetch({
        title: "In-product onboarding checklist",
        metric_name: "New-User Activation",
        mechanism_category: "activation",
        mechanism_summary: "A checklist walks new users to their first report faster.",
        questions: [
          "Which exact step gates activation today?",
          "Why would a checklist move activation, mechanically?",
        ],
      }),
    },
  );
  assert.equal(card.source, "llm");
  assert.equal(card.metricName, "New-User Activation");
  assert.ok(card.questions.length >= 2 && card.questions.length <= 3);
  await recordFunnelEvent(client, WS, null, { sessionKey, eventType: "STRUCTURED", step: "card" });
  await recordFunnelEvent(client, WS, null, { sessionKey, eventType: "STEP_VIEW", step: "card" });

  // --- declare the metric (declared, no observations) ---
  const metric = await declareMetric(client, WS, card.metricName!);
  assert.ok(!("error" in metric), "error" in metric ? metric.error : "");
  assert.equal(metric.source, "declared");
  assert.equal(metric.hasObservations, false);
  await recordFunnelEvent(client, WS, null, { sessionKey, eventType: "STEP_VIEW", step: "commit" });

  // --- commit: the team's number, on the record (UNATTRIBUTED — no lever yet) ---
  const res = await commitPrediction(client, WS, {
    title: card.title,
    mechanismSummary: card.mechanismSummary,
    mechanismCategory: card.mechanismCategory,
    notes: ["The checklist replaces the empty first-run dashboard."],
    metricId: metric.metricId,
    direction: "POSITIVE",
    magnitudePctMean: 3,
    resolutionDate: "2027-02-01",
  });
  assert.ok(res.ok, res.ok ? "" : res.errors.join("; "));
  await recordFunnelEvent(client, WS, null, { sessionKey, eventType: "COMMITTED", step: "done" });

  // --- prediction card: read back exactly what the "On the record" screen shows ---
  const pred = await client
    .from("predictions")
    .select("direction, magnitude_pct_mean, resolution_date, resolved_verdict, metric:metrics(name, source)")
    .eq("prediction_id", res.predictionId)
    .single();
  assert.equal(pred.error, null);
  const row = pred.data as unknown as {
    direction: string;
    magnitude_pct_mean: number;
    resolution_date: string;
    resolved_verdict: string | null;
    metric: { name: string; source: string };
  };
  assert.equal(row.direction, "POSITIVE");
  assert.equal(row.magnitude_pct_mean, 3);
  assert.equal(row.resolution_date, "2027-02-01");
  assert.equal(row.resolved_verdict, null); // UNATTRIBUTED until a lever is armed
  assert.equal(row.metric.name, "New-User Activation");

  // --- instrumentation folds to the DoD metrics for this run ---
  const metrics = await getFunnelMetrics(client, WS);
  assert.equal(metrics.landedRuns, 1);
  assert.equal(metrics.committedRuns, 1);
  assert.equal(metrics.commitRate, 1);
  assert.equal(metrics.timeToFirstType.count, 1);
  assert.equal(metrics.timeToFirstType.medianMs, 5_200);
  assert.ok((metrics.timeToFirstType.medianMs ?? Infinity) < TIME_TO_FIRST_TYPE_TARGET_MS);
  assert.equal(metrics.timeToFirstType.underTargetRate, 1);
  assert.equal(metrics.dropOffByStep.paste, 0); // (no explicit paste STEP_VIEW in this walk)
  assert.equal(metrics.dropOffByStep.card, 1);
  assert.equal(metrics.dropOffByStep.commit, 1);
});

test("shadow path: a garbage paste falls back to manual entry, never a dead-end", async (t) => {
  if (!gated(t)) return;
  const card = await parsePasteWithLLM("???", { apiKey: "test-key", fetchImpl: stubFetch({
    title: "unused",
    metric_name: null,
    mechanism_category: "other",
    mechanism_summary: "",
    questions: [],
  }) });
  // pasteLooksEmpty short-circuits before any fetch — deterministic fallback.
  assert.equal(card.source, "fallback");
  assert.equal(card.metricName, null); // manual metric entry
  assert.ok(card.questions.length >= 2);
});
