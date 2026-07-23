import type { SupabaseClient } from "@supabase/supabase-js";

import { scanDecisionReportGaps } from "./editing.ts";
import { UUID_PATTERN } from "./persistence.ts";
import { sanitizeReportImage, type SanitizedReportImage } from "./image.ts";
import {
  validateDecisionReport,
  validateMetricProjection,
  type DecisionReportV1,
  type MetricProjection,
} from "./schema.ts";

export const REPORT_ASSET_BUCKET = "decision-report-assets";

export type ReportAssetView = {
  assetId: string;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  byteSize: number;
  previewUrl: string;
};

export type ReportAssetMutationResult =
  | { ok: true; revisionId: string; status: "draft" | "report_ready"; asset: ReportAssetView | null }
  | { ok: false; code: "validation" | "conflict" | "forbidden" | "storage" | "database"; error: string };

type AssetMutationInput = {
  reportId: string;
  baseRevisionId: string;
  report: DecisionReportV1;
  metricProjection: MetricProjection;
  authoredBy: string | null;
};

function statusFor(report: DecisionReportV1): "draft" | "report_ready" {
  return scanDecisionReportGaps(report).length === 0 ? "report_ready" : "draft";
}

function errorResult(error: { code?: string; message: string; details?: string | null }): ReportAssetMutationResult {
  if (error.code === "40001" || error.message.includes("STALE_REVISION") || error.message.includes("REPORT_ALREADY_ACTIVE")) {
    return { ok: false, code: "conflict", error: error.message.includes("ACTIVE")
      ? "This report is active and its supplied image can no longer be changed."
      : "This report changed in another tab. Reload it before changing the image." };
  }
  if (error.code === "42501") return { ok: false, code: "forbidden", error: "This report or image is unavailable in the current workspace." };
  return { ok: false, code: "database", error: error.message };
}

function validateInput(input: AssetMutationInput): { report: DecisionReportV1; projection: MetricProjection } | ReportAssetMutationResult {
  if (!UUID_PATTERN.test(input.reportId) || !UUID_PATTERN.test(input.baseRevisionId)) {
    return { ok: false, code: "validation", error: "Save the report before changing its supplied image." };
  }
  const report = validateDecisionReport(input.report);
  const projection = validateMetricProjection(input.metricProjection);
  if (!report.success || !projection.success) {
    return { ok: false, code: "validation", error: [...(report.success ? [] : report.errors), ...(projection.success ? [] : projection.errors)].join("; ") };
  }
  return { report: report.data, projection: projection.data };
}

async function removeObjectAndMetadata(sb: SupabaseClient, assetId: string, path: string, authoredBy: string | null) {
  const removed = await sb.storage.from(REPORT_ASSET_BUCKET).remove([path]);
  if (!removed.error) {
    await sb.rpc("abandon_decision_report_asset_v1", { p_asset_id: assetId, p_authored_by: authoredBy });
  }
}

async function cleanupDetached(sb: SupabaseClient, reportId: string, authoredBy: string | null) {
  const response = await sb.from("report_assets").select("asset_id, object_path").eq("report_id", reportId).eq("status", "detached");
  if (response.error || !response.data) return;
  for (const row of response.data as Array<{ asset_id: string; object_path: string }>) {
    await removeObjectAndMetadata(sb, row.asset_id, row.object_path, authoredBy);
  }
}

async function attachedAssetAfterRetry(sb: SupabaseClient, assetId: string, contentHash: string): Promise<ReportAssetView | null> {
  const response = await sb.from("report_assets")
    .select("asset_id, media_type, width, height, byte_size, status")
    .eq("asset_id", assetId).eq("content_hash", contentHash).eq("status", "attached").maybeSingle();
  if (response.error || !response.data) return null;
  const row = response.data as { asset_id: string; media_type: "image/png" | "image/jpeg"; width: number; height: number; byte_size: number };
  return { assetId: row.asset_id, mediaType: row.media_type, width: row.width, height: row.height, byteSize: row.byte_size, previewUrl: `/api/decision-report-assets/${row.asset_id}` };
}

export async function attachReportImage(
  sb: SupabaseClient,
  input: AssetMutationInput,
  source: Uint8Array,
): Promise<ReportAssetMutationResult> {
  const validated = validateInput(input);
  if ("ok" in validated) return validated;
  let image: SanitizedReportImage;
  try {
    image = await sanitizeReportImage(source);
  } catch (error) {
    return { ok: false, code: "validation", error: error instanceof Error ? error.message : "The image is invalid." };
  }

  const reserved = await sb.rpc("reserve_decision_report_asset_v1", {
    p_report_id: input.reportId,
    p_base_revision_id: input.baseRevisionId,
    p_extension: image.extension,
    p_authored_by: input.authoredBy,
  });
  if (reserved.error) return errorResult(reserved.error);
  const row = Array.isArray(reserved.data) ? reserved.data[0] as { asset_id?: string; object_path?: string; reused?: boolean } : null;
  if (!row || !row.asset_id || !row.object_path || !UUID_PATTERN.test(row.asset_id)) {
    return { ok: false, code: "database", error: "The database returned an invalid image reservation." };
  }

  if (row.reused) {
    const removed = await sb.storage.from(REPORT_ASSET_BUCKET).remove([row.object_path]);
    if (removed.error) {
      return { ok: false, code: "storage", error: "A previous image attempt could not be cleared. Try again." };
    }
  }
  const uploaded = await sb.storage.from(REPORT_ASSET_BUCKET).upload(row.object_path, image.bytes, {
    contentType: image.mediaType,
    cacheControl: "60",
    upsert: false,
  });
  if (uploaded.error) {
    await sb.rpc("abandon_decision_report_asset_v1", { p_asset_id: row.asset_id, p_authored_by: input.authoredBy });
    return { ok: false, code: "storage", error: "The clean image could not be stored. Your report was not changed—try again." };
  }

  const report = structuredClone(validated.report);
  report.implementation.assetIds = [row.asset_id];
  const attached = await sb.rpc("attach_decision_report_asset_v1", {
    p_asset_id: row.asset_id,
    p_report_id: input.reportId,
    p_base_revision_id: input.baseRevisionId,
    p_title: report.title,
    p_status: statusFor(report),
    p_snapshot: report,
    p_metric_projection: validated.projection,
    p_media_type: image.mediaType,
    p_byte_size: image.bytes.length,
    p_width: image.width,
    p_height: image.height,
    p_content_hash: image.contentHash,
    p_authored_by: input.authoredBy,
  });
  if (attached.error) {
    const committed = await attachedAssetAfterRetry(sb, row.asset_id, image.contentHash);
    if (committed) {
      await cleanupDetached(sb, input.reportId, input.authoredBy);
      const current = await sb.from("decision_reports").select("current_revision_id, status").eq("report_id", input.reportId).maybeSingle();
      const currentRow = current.data as { current_revision_id?: string; status?: "draft" | "report_ready" | "active" } | null;
      if (currentRow?.current_revision_id && currentRow.status && currentRow.status !== "active") {
        return { ok: true, revisionId: currentRow.current_revision_id, status: currentRow.status, asset: committed };
      }
    }
    await removeObjectAndMetadata(sb, row.asset_id, row.object_path, input.authoredBy);
    return errorResult(attached.error);
  }
  const saved = Array.isArray(attached.data) ? attached.data[0] as { revision_id?: string; status?: "draft" | "report_ready" } : null;
  if (!saved?.revision_id || !UUID_PATTERN.test(saved.revision_id)) {
    return { ok: false, code: "database", error: "The database returned an invalid image revision." };
  }
  await cleanupDetached(sb, input.reportId, input.authoredBy);
  return {
    ok: true,
    revisionId: saved.revision_id,
    status: saved.status ?? statusFor(report),
    asset: {
      assetId: row.asset_id,
      mediaType: image.mediaType,
      width: image.width,
      height: image.height,
      byteSize: image.bytes.length,
      previewUrl: `/api/decision-report-assets/${row.asset_id}`,
    },
  };
}

export async function detachReportImage(
  sb: SupabaseClient,
  input: AssetMutationInput,
  assetId: string,
): Promise<ReportAssetMutationResult> {
  const validated = validateInput(input);
  if ("ok" in validated) return validated;
  if (!UUID_PATTERN.test(assetId)) return { ok: false, code: "validation", error: "The supplied image address is invalid." };
  const report = structuredClone(validated.report);
  report.implementation.assetIds = [];
  const detached = await sb.rpc("detach_decision_report_asset_v1", {
    p_asset_id: assetId,
    p_report_id: input.reportId,
    p_base_revision_id: input.baseRevisionId,
    p_title: report.title,
    p_status: statusFor(report),
    p_snapshot: report,
    p_metric_projection: validated.projection,
    p_authored_by: input.authoredBy,
  });
  if (detached.error) return errorResult(detached.error);
  const row = Array.isArray(detached.data) ? detached.data[0] as { revision_id?: string; status?: "draft" | "report_ready"; object_path?: string } : null;
  if (!row?.revision_id || !row.object_path) return { ok: false, code: "database", error: "The database returned an invalid image removal." };
  await removeObjectAndMetadata(sb, assetId, row.object_path, input.authoredBy);
  return { ok: true, revisionId: row.revision_id, status: row.status ?? statusFor(report), asset: null };
}

export async function loadAttachedReportAsset(sb: SupabaseClient, reportId: string): Promise<ReportAssetView | null> {
  if (!UUID_PATTERN.test(reportId)) return null;
  const response = await sb.from("report_assets").select("asset_id, media_type, width, height, byte_size")
    .eq("report_id", reportId).eq("status", "attached").maybeSingle();
  if (response.error || !response.data) return null;
  const row = response.data as { asset_id: string; media_type: "image/png" | "image/jpeg"; width: number; height: number; byte_size: number };
  return { assetId: row.asset_id, mediaType: row.media_type, width: row.width, height: row.height, byteSize: row.byte_size, previewUrl: `/api/decision-report-assets/${row.asset_id}` };
}
