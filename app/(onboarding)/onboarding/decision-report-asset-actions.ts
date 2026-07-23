"use server";

import { getSession } from "@/lib/auth/session";
import { attachReportImage, detachReportImage, type ReportAssetMutationResult } from "@/lib/decision-reports/assets";
import type { DecisionReportV1, MetricProjection } from "@/lib/decision-reports/schema";
import { getServerSupabase, isLocalDemo } from "@/lib/supabase-server";

type Input = {
  reportId: string;
  baseRevisionId: string;
  report: DecisionReportV1;
  metricProjection: MetricProjection;
};

async function context(input: Input) {
  const session = await getSession();
  if (!isLocalDemo() && !session.userId) return null;
  return { sb: await getServerSupabase(), session, input: { ...input, authoredBy: session.userId } };
}

export async function uploadDecisionReportImageAction(input: Input, formData: FormData): Promise<ReportAssetMutationResult> {
  const ctx = await context(input);
  if (!ctx) return { ok: false, code: "forbidden", error: "Sign in before uploading a supplied image." };
  const file = formData.get("image");
  if (!(file instanceof File)) return { ok: false, code: "validation", error: "Choose a PNG or JPEG image to upload." };
  if (file.size > 5 * 1024 * 1024) return { ok: false, code: "validation", error: "The image must be 5 MB or smaller." };
  return attachReportImage(ctx.sb, ctx.input, new Uint8Array(await file.arrayBuffer()));
}

export async function removeDecisionReportImageAction(input: Input, assetId: string): Promise<ReportAssetMutationResult> {
  const ctx = await context(input);
  if (!ctx) return { ok: false, code: "forbidden", error: "Sign in before removing a supplied image." };
  return detachReportImage(ctx.sb, ctx.input, assetId);
}
