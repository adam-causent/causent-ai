import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { cloneDecisionReport } from "./schema.ts";
import { GUMMY_ALPHA_GOLDEN_EXAMPLE } from "./fixtures/gummy-alpha.ts";
import { createSafeFallbackReport } from "./generation-contract.ts";
import { deleteDecisionReport, loadDecisionReport, saveDecisionReport } from "./persistence.ts";

function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !line.trim().startsWith("#")) out[match[1]] = match[2];
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

const ORG = randomUUID();
const PROJECT = randomUUID();
const WORKSPACE = randomUUID();

let sb: SupabaseClient | null = null;
let available = false;

async function teardown(client: SupabaseClient) {
  await client.from("orgs").delete().eq("org_id", ORG);
}

before(async () => {
  if (!URL || !KEY) return;
  sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const probe = await sb
    .from("decision_reports")
    .select("report_id")
    .limit(1)
    .then((result) => result, () => ({ error: new Error("unreachable") }));
  if (probe.error) return;

  available = true;
  await teardown(sb);
  const org = await sb.from("orgs").insert({ org_id: ORG, name: "REPORT_TEST_org" });
  assert.equal(org.error, null, org.error?.message);
  const project = await sb
    .from("projects")
    .insert({ project_id: PROJECT, org_id: ORG, name: "Orbit" });
  assert.equal(project.error, null, project.error?.message);
  const workspace = await sb
    .from("workspaces")
    .insert({ workspace_id: WORKSPACE, project_id: PROJECT, name: "Gummy Alpha" });
  assert.equal(workspace.error, null, workspace.error?.message);
});

after(async () => {
  if (sb && available) await teardown(sb);
});

function gated(t: TestContext): boolean {
  if (!available) {
    t.skip("Decision Report persistence migration is unavailable — start/reset local Supabase");
    return false;
  }
  return true;
}

test("explicit saves are append-only, retry-safe, conflict-safe, and create no graph rows", async (t) => {
  if (!gated(t) || !sb) return;

  const workspaceProbe = await sb
    .from("workspaces")
    .select("workspace_id")
    .eq("workspace_id", WORKSPACE)
    .maybeSingle();
  assert.equal(workspaceProbe.error, null, workspaceProbe.error?.message);
  assert.equal(workspaceProbe.data?.workspace_id, WORKSPACE);

  const first = await saveDecisionReport(sb, WORKSPACE, {
    reportId: null,
    baseRevisionId: null,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(first.ok, true, first.ok ? undefined : first.error);
  if (!first.ok) return;
  assert.equal(first.saved.status, "report_ready");
  assert.equal(first.reused, false);

  const retry = await saveDecisionReport(sb, WORKSPACE, {
    reportId: first.saved.reportId,
    baseRevisionId: first.saved.revisionId,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(retry.ok, true, retry.ok ? undefined : retry.error);
  if (!retry.ok) return;
  assert.equal(retry.reused, true);
  assert.equal(retry.saved.revisionId, first.saved.revisionId);

  const editedReport = cloneDecisionReport(GUMMY_ALPHA_GOLDEN_EXAMPLE.report);
  editedReport.decision.decision[0] = {
    ...editedReport.decision.decision[0],
    text: "Deploy the assistant to a limited Gummy Alpha partner cohort first.",
    status: "user_confirmed",
    sourceChunkIds: [],
  };
  const edited = await saveDecisionReport(sb, WORKSPACE, {
    reportId: first.saved.reportId,
    baseRevisionId: first.saved.revisionId,
    report: editedReport,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(edited.ok, true, edited.ok ? undefined : edited.error);
  if (!edited.ok) return;
  assert.equal(edited.reused, false);
  assert.notEqual(edited.saved.revisionId, first.saved.revisionId);
  assert.equal(edited.saved.baseRevisionId, first.saved.revisionId);

  const staleReport = cloneDecisionReport(GUMMY_ALPHA_GOLDEN_EXAMPLE.report);
  staleReport.title = "A stale edit from another tab";
  const stale = await saveDecisionReport(sb, WORKSPACE, {
    reportId: first.saved.reportId,
    baseRevisionId: first.saved.revisionId,
    report: staleReport,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, "conflict");
    assert.equal(stale.currentRevisionId, edited.saved.revisionId);
  }

  const revisions = await sb
    .from("decision_report_revisions")
    .select("revision_id, revision_number")
    .eq("report_id", first.saved.reportId)
    .order("revision_number");
  assert.equal(revisions.error, null);
  assert.deepEqual(revisions.data?.map((row) => row.revision_number), [1, 2]);

  const loaded = await loadDecisionReport(sb, WORKSPACE, first.saved.reportId);
  assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.error);
  if (loaded.ok) {
    assert.equal(loaded.saved.revisionId, edited.saved.revisionId);
    assert.deepEqual(loaded.saved.report, editedReport);
    assert.deepEqual(
      loaded.saved.metricProjection,
      GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    );
  }

  const canonicalCounts = await Promise.all([
    sb.from("decisions").select("*", { count: "exact", head: true }).eq("scope_id", WORKSPACE),
    sb.from("predictions").select("*", { count: "exact", head: true }).eq("scope_id", WORKSPACE),
    sb.from("actions").select("*", { count: "exact", head: true }).eq("scope_id", WORKSPACE),
    sb.from("levers").select("*", { count: "exact", head: true }).eq("scope_id", WORKSPACE),
  ]);
  for (const [index, table] of ["decisions", "predictions", "actions", "levers"].entries()) {
    const countResult = canonicalCounts[index];
    assert.equal(countResult.error, null, `${table}: ${countResult.error?.message}`);
    assert.equal(countResult.count, 0, `${table} must remain untouched by report saves`);
  }
});

test("the database refuses report_ready for a sparse snapshot", async (t) => {
  if (!gated(t) || !sb) return;
  let index = 0;
  const fallback = createSafeFallbackReport("Launch a new partner onboarding experience.", {
    idFactory: () => `db-fallback-${index++}`,
  });
  const result = await sb.rpc("create_decision_report_v1", {
    p_scope_id: WORKSPACE,
    p_title: fallback.report.title,
    p_status: "report_ready",
    p_snapshot: fallback.report,
    p_metric_projection: fallback.metricProjection,
    p_authored_by: null,
  });
  assert.equal(result.error?.code, "22023");
  assert.match(result.error?.message ?? "", /Required report fields are incomplete/);
});

test("ordinary saves cannot promote an arbitrary supplied-image id", async (t) => {
  if (!gated(t) || !sb) return;
  const created = await saveDecisionReport(sb, WORKSPACE, {
    reportId: null,
    baseRevisionId: null,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const forged = cloneDecisionReport(created.saved.report);
  forged.implementation.assetIds = [randomUUID()];
  const result = await saveDecisionReport(sb, WORKSPACE, {
    reportId: created.saved.reportId,
    baseRevisionId: created.saved.revisionId,
    report: forged,
    metricProjection: created.saved.metricProjection,
    authoredBy: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "forbidden");
});

test("non-active reports leave history after a retry-safe soft deletion", async (t) => {
  if (!gated(t) || !sb) return;
  const created = await saveDecisionReport(sb, WORKSPACE, {
    reportId: null,
    baseRevisionId: null,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const removed = await deleteDecisionReport(sb, WORKSPACE, created.saved.reportId, null);
  assert.equal(removed.ok, true, removed.ok ? undefined : removed.error);
  if (!removed.ok) return;
  assert.equal(removed.reused, false);
  const retry = await deleteDecisionReport(sb, WORKSPACE, created.saved.reportId, null);
  assert.equal(retry.ok, true, retry.ok ? undefined : retry.error);
  if (retry.ok) assert.equal(retry.reused, true);

  const loaded = await loadDecisionReport(sb, WORKSPACE, created.saved.reportId);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, "not_found");
  const revisionCount = await sb
    .from("decision_report_revisions")
    .select("revision_id", { count: "exact", head: true })
    .eq("report_id", created.saved.reportId);
  assert.equal(revisionCount.error, null, revisionCount.error?.message);
  assert.equal(revisionCount.count, 1);
});
