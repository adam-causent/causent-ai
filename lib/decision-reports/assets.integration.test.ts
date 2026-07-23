import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

import { attachReportImage, detachReportImage, REPORT_ASSET_BUCKET } from "./assets.ts";
import { GUMMY_ALPHA_GOLDEN_EXAMPLE } from "./fixtures/gummy-alpha.ts";
import { loadDecisionReport, saveDecisionReport } from "./persistence.ts";

function localEnv() {
  try {
    return Object.fromEntries(readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n").flatMap((line) => {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      return match && !line.trim().startsWith("#") ? [[match[1], match[2]]] : [];
    }));
  } catch { return {} as Record<string, string>; }
}

const env = localEnv();
const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const ORG = randomUUID();
const PROJECT = randomUUID();
const WORKSPACE = randomUUID();
let sb: SupabaseClient | null = null;
let available = false;

before(async () => {
  if (!URL || !KEY) return;
  sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const probe = await sb.from("report_assets").select("asset_id").limit(1);
  if (probe.error) return;
  available = true;
  await sb.from("orgs").delete().eq("org_id", ORG);
  assert.equal((await sb.from("orgs").insert({ org_id: ORG, name: "ASSET_TEST_org" })).error, null);
  assert.equal((await sb.from("projects").insert({ project_id: PROJECT, org_id: ORG, name: "Orbit" })).error, null);
  assert.equal((await sb.from("workspaces").insert({ workspace_id: WORKSPACE, project_id: PROJECT, name: "Asset test" })).error, null);
});

after(async () => { if (sb && available) await sb.from("orgs").delete().eq("org_id", ORG); });

function gated(t: TestContext) {
  if (!available || !sb) { t.skip("Decision Report asset migration/Storage is unavailable — start/reset local Supabase"); return false; }
  return true;
}

test("sanitized upload, replacement, exact reload, and removal follow append-only revisions", async (t) => {
  if (!gated(t) || !sb) return;
  const created = await saveDecisionReport(sb, WORKSPACE, {
    reportId: null, baseRevisionId: null,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });
  assert.equal(created.ok, true, created.ok ? undefined : created.error);
  if (!created.ok) return;
  const input = { reportId: created.saved.reportId, baseRevisionId: created.saved.revisionId, report: created.saved.report, metricProjection: created.saved.metricProjection, authoredBy: null };
  const firstBytes = await sharp({ create: { width: 12, height: 8, channels: 4, background: "#226699" } }).png().toBuffer();
  const first = await attachReportImage(sb, input, firstBytes);
  assert.equal(first.ok, true, first.ok ? undefined : first.error);
  if (!first.ok || !first.asset) return;
  const loaded = await loadDecisionReport(sb, WORKSPACE, created.saved.reportId);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.deepEqual(loaded.saved.report.implementation.assetIds, [first.asset.assetId]);

  const firstMeta = await sb.from("report_assets").select("object_path").eq("asset_id", first.asset.assetId).single();
  assert.equal(firstMeta.error, null);
  assert.equal((await sb.storage.from(REPORT_ASSET_BUCKET).download(firstMeta.data!.object_path)).error, null);

  const reportWithFirst = structuredClone(input.report);
  reportWithFirst.implementation.assetIds = [first.asset.assetId];
  const secondBytes = await sharp({ create: { width: 9, height: 7, channels: 3, background: "#cc8844" } }).jpeg().toBuffer();
  const second = await attachReportImage(sb, { ...input, baseRevisionId: first.revisionId, report: reportWithFirst }, secondBytes);
  assert.equal(second.ok, true, second.ok ? undefined : second.error);
  if (!second.ok || !second.asset) return;
  assert.notEqual(second.asset.assetId, first.asset.assetId);
  assert.equal((await sb.from("report_assets").select("asset_id", { count: "exact", head: true }).eq("asset_id", first.asset.assetId)).count, 0);

  const reportWithSecond = structuredClone(reportWithFirst);
  reportWithSecond.implementation.assetIds = [second.asset.assetId];
  const removed = await detachReportImage(sb, { ...input, baseRevisionId: second.revisionId, report: reportWithSecond }, second.asset.assetId);
  assert.equal(removed.ok, true, removed.ok ? undefined : removed.error);
  const final = await loadDecisionReport(sb, WORKSPACE, created.saved.reportId);
  assert.equal(final.ok, true);
  if (final.ok) assert.deepEqual(final.saved.report.implementation.assetIds, []);
});

test("forged report identity is rejected before Storage receives bytes", async (t) => {
  if (!gated(t) || !sb) return;
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  const result = await attachReportImage(sb, {
    reportId: randomUUID(), baseRevisionId: randomUUID(), report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection, authoredBy: null,
  }, bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "forbidden");
});
