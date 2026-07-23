import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { GUMMY_ALPHA_GOLDEN_EXAMPLE } from "../decision-reports/fixtures/gummy-alpha.ts";
import {
  loadReportActivationMetrics,
  materializeReportActivation,
} from "../decision-reports/materialization.ts";
import { saveDecisionReport } from "../decision-reports/persistence.ts";
import {
  importReportMetricObservations,
  importWorkspaceMetricCsv,
  setWorkspaceCoreMetric,
} from "./import.ts";

function localEnv(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n").flatMap((line) => {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      return match && !line.trim().startsWith("#") ? [[match[1], match[2]]] : [];
    }));
  } catch { return {}; }
}

const env = localEnv();
const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const ORG = randomUUID();
const PROJECT = randomUUID();
const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const METRIC = randomUUID();
const OTHER_METRIC = randomUUID();
let sb: SupabaseClient | null = null;
let available = false;
let reportId = "";

async function teardown(client: SupabaseClient) { await client.from("orgs").delete().eq("org_id", ORG); }

before(async () => {
  if (!URL || !KEY) return;
  sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const probe = await sb.rpc("import_active_report_metric_csv_v1", {
    p_scope_id: WORKSPACE,
    p_report_id: randomUUID(),
    p_metric_id: METRIC,
    p_observations: [{ date: "2026-07-20", value: 1 }],
    p_authored_by: null,
  }).then((result) => result, () => ({ error: { code: "unreachable" } }));
  if (probe.error && !["42501", "22023", "P0002"].includes(probe.error.code ?? "")) return;
  available = true;
  await teardown(sb);
  assert.equal((await sb.from("orgs").insert({ org_id: ORG, name: "METRIC_IMPORT_TEST" })).error, null);
  assert.equal((await sb.from("projects").insert({ project_id: PROJECT, org_id: ORG, name: "p" })).error, null);
  assert.equal((await sb.from("workspaces").insert([
    { workspace_id: WORKSPACE, project_id: PROJECT, name: "w" },
    { workspace_id: OTHER_WORKSPACE, project_id: PROJECT, name: "other" },
  ])).error, null);
  assert.equal((await sb.from("metrics").insert([
    { metric_id: METRIC, scope_id: WORKSPACE, name: "Activation Rate", source: "declared", granularity: "daily" },
    { metric_id: OTHER_METRIC, scope_id: OTHER_WORKSPACE, name: "Foreign Metric", source: "declared", granularity: "daily" },
  ])).error, null);
  const saved = await saveDecisionReport(sb, WORKSPACE, {
    reportId: null,
    baseRevisionId: null,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  reportId = saved.saved.reportId;
  const activated = await materializeReportActivation(sb, {
    schemaVersion: 1,
    reportId,
    revisionId: saved.saved.revisionId,
    confirmedMetricId: METRIC,
    prediction: { direction: "POSITIVE", magnitudePctMean: 5, resolutionDate: "2027-01-15" },
    selectedActionSourceItemIds: [GUMMY_ALPHA_GOLDEN_EXAMPLE.report.implementation.actions[0].sourceItemId],
  }, null);
  assert.equal(activated.ok, true, activated.ok ? undefined : activated.error);
});

after(async () => { if (sb && available) await teardown(sb); });

function gated(t: TestContext): boolean {
  if (!available || !sb || !reportId) { t.skip("Slice 7 migration/local Supabase unavailable"); return false; }
  return true;
}

test("imports atomically and retries idempotently without duplicating observations", async (t) => {
  if (!gated(t) || !sb) return;
  const first = await importReportMetricObservations(sb, {
    scopeId: WORKSPACE, reportId, metricId: METRIC, authoredBy: null,
    observations: [{ date: "2026-07-20", value: 10 }, { date: "2026-07-21", value: 11 }],
  });
  assert.equal(first.ok, true, first.ok ? undefined : first.error);
  if (!first.ok) return;
  assert.deepEqual({ inserted: first.summary.insertedRows, updated: first.summary.updatedRows }, { inserted: 2, updated: 0 });

  const retry = await importReportMetricObservations(sb, {
    scopeId: WORKSPACE, reportId, metricId: METRIC, authoredBy: null,
    observations: [{ date: "2026-07-20", value: 10 }, { date: "2026-07-21", value: 12 }],
  });
  assert.equal(retry.ok, true, retry.ok ? undefined : retry.error);
  if (!retry.ok) return;
  assert.deepEqual({ inserted: retry.summary.insertedRows, updated: retry.summary.updatedRows }, { inserted: 0, updated: 2 });
  const rows = await sb.from("metric_observations").select("obs_date,value").eq("metric_id", METRIC).order("obs_date");
  assert.equal(rows.data?.length, 2);
  assert.equal(Number(rows.data?.[1].value), 12);
  const metric = await sb.from("metrics").select("source").eq("metric_id", METRIC).single();
  assert.equal(metric.data?.source, "csv");
});

test("rejects forged report, metric, and cross-workspace combinations with no foreign write", async (t) => {
  if (!gated(t) || !sb) return;
  for (const target of [
    { scopeId: WORKSPACE, reportId: randomUUID(), metricId: METRIC },
    { scopeId: WORKSPACE, reportId, metricId: OTHER_METRIC },
    { scopeId: OTHER_WORKSPACE, reportId, metricId: OTHER_METRIC },
  ]) {
    const result = await importReportMetricObservations(sb, {
      ...target,
      authoredBy: null,
      observations: [{ date: "2026-07-22", value: 99 }],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "forbidden");
  }
  const foreign = await sb.from("metric_observations").select("obs_date").eq("metric_id", OTHER_METRIC);
  assert.equal(foreign.data?.length, 0);
});

test("creates a named workspace CSV metric, shows it as selectable data, and retries safely", async (t) => {
  if (!gated(t) || !sb) return;
  const observations = [
    { date: "2026-07-20", value: 0.41 },
    { date: "2026-07-21", value: 0.43 },
  ];
  const first = await importWorkspaceMetricCsv(sb, {
    scopeId: WORKSPACE,
    name: "AI assistant adoption rate",
    unit: "percent",
    observations,
    authoredBy: null,
  });
  assert.equal(first.ok, true, first.ok ? undefined : first.error);
  if (!first.ok) return;
  assert.equal(first.summary.created, true);
  assert.equal(first.summary.insertedRows, 2);

  const catalog = await sb
    .from("metrics")
    .select("metric_id, name, source, unit")
    .eq("scope_id", WORKSPACE)
    .ilike("name", "AI assistant adoption rate")
    .single();
  assert.equal(catalog.error, null, catalog.error?.message);
  assert.equal(catalog.data?.source, "csv");
  assert.equal(catalog.data?.unit, "percent");

  const retry = await importWorkspaceMetricCsv(sb, {
    scopeId: WORKSPACE,
    name: "AI assistant adoption rate",
    unit: "percent",
    observations: [{ ...observations[0], value: 0.44 }, observations[1]],
    authoredBy: null,
  });
  assert.equal(retry.ok, true, retry.ok ? undefined : retry.error);
  if (!retry.ok) return;
  assert.equal(retry.summary.created, false);
  assert.equal(retry.summary.insertedRows, 0);
  assert.equal(retry.summary.updatedRows, 2);

  const rows = await sb
    .from("metric_observations")
    .select("obs_date, value")
    .eq("metric_id", catalog.data?.metric_id)
    .order("obs_date");
  assert.equal(rows.data?.length, 2);
  assert.equal(Number(rows.data?.[0].value), 0.44);

  const activationMetrics = await loadReportActivationMetrics(sb, WORKSPACE);
  const catalogMetric = activationMetrics.find((metric) => metric.metricId === catalog.data?.metric_id);
  assert.equal(catalogMetric?.name, "AI assistant adoption rate");
  assert.equal(catalogMetric?.hasObservations, true);

  const selected = await setWorkspaceCoreMetric(sb, {
    scopeId: WORKSPACE,
    metricId: catalog.data!.metric_id,
    isCore: true,
    authoredBy: null,
  });
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error);
  if (selected.ok) assert.equal(selected.coreMetricCount, 1);
  const selectedCatalog = await loadReportActivationMetrics(sb, WORKSPACE);
  assert.equal(selectedCatalog.find((metric) => metric.metricId === catalog.data?.metric_id)?.isCore, true);

  const removed = await setWorkspaceCoreMetric(sb, {
    scopeId: WORKSPACE,
    metricId: catalog.data!.metric_id,
    isCore: false,
    authoredBy: null,
  });
  assert.equal(removed.ok, true, removed.ok ? undefined : removed.error);
  if (removed.ok) assert.equal(removed.coreMetricCount, 0);
});

test("workspace metric import rejects a missing workspace before writing", async (t) => {
  if (!gated(t) || !sb) return;
  for (const scopeId of [randomUUID()]) {
    const result = await importWorkspaceMetricCsv(sb, {
      scopeId,
      name: "Should not be written",
      unit: "count",
      observations: [{ date: "2026-07-22", value: 1 }],
      authoredBy: null,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "forbidden");
  }
  const foreign = await sb
    .from("metrics")
    .select("metric_id")
    .eq("scope_id", OTHER_WORKSPACE)
    .ilike("name", "Should not be written");
  assert.equal(foreign.data?.length, 0);
});
