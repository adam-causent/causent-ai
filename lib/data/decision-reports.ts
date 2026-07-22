import { cache } from "react";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID } from "@/lib/data/config";
import {
  validateDecisionReport,
  validateMetricProjection,
  type DecisionReportV1,
  type MetricProjection,
} from "@/lib/decision-reports/schema";

export type DashboardDecisionReport = {
  id: string;
  revisionId: string;
  title: string;
  status: "draft" | "report_ready" | "active";
  updatedAt: string;
  report: DecisionReportV1;
  metricProjection: MetricProjection;
  decisionId: string | null;
  predictionId: string | null;
  metricId: string | null;
};

type ReportRow = {
  report_id: string;
  title: string;
  status: DashboardDecisionReport["status"];
  current_revision_id: string | null;
  active_decision_id: string | null;
  active_prediction_id: string | null;
  active_metric_id: string | null;
  updated_at: string;
};

type RevisionRow = {
  revision_id: string;
  snapshot: unknown;
  metric_projection: unknown;
};

/** Saved Decision Reports are the report-native project index for the dashboard. */
export const getDecisionReports = cache(async function getDecisionReports(): Promise<
  DashboardDecisionReport[]
> {
  const sb = await getServerSupabase();
  const reportsRes = await sb
    .from("decision_reports")
    .select(
      "report_id, title, status, current_revision_id, active_decision_id, " +
        "active_prediction_id, active_metric_id, updated_at",
    )
    .eq("scope_id", DEMO_SCOPE_ID)
    .order("updated_at", { ascending: false });
  if (reportsRes.error) throw reportsRes.error;

  const rows = (reportsRes.data ?? []) as unknown as ReportRow[];
  const revisionIds = rows
    .map((row) => row.current_revision_id)
    .filter((id): id is string => id !== null);
  if (revisionIds.length === 0) return [];

  const revisionsRes = await sb
    .from("decision_report_revisions")
    .select("revision_id, snapshot, metric_projection")
    .eq("scope_id", DEMO_SCOPE_ID)
    .in("revision_id", revisionIds);
  if (revisionsRes.error) throw revisionsRes.error;
  const revisionById = new Map(
    ((revisionsRes.data ?? []) as RevisionRow[]).map((row) => [row.revision_id, row]),
  );

  return rows.flatMap((row) => {
    if (!row.current_revision_id) return [];
    const revision = revisionById.get(row.current_revision_id);
    if (!revision) return [];
    const report = validateDecisionReport(revision.snapshot);
    const projection = validateMetricProjection(revision.metric_projection);
    if (!report.success || !projection.success) return [];
    return [{
      id: row.report_id,
      revisionId: row.current_revision_id,
      title: row.title,
      status: row.status,
      updatedAt: row.updated_at,
      report: report.data,
      metricProjection: projection.data,
      decisionId: row.active_decision_id,
      predictionId: row.active_prediction_id,
      metricId: row.active_metric_id,
    }];
  });
});
