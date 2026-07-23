"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { getServerSupabase, isLocalDemo } from "@/lib/supabase-server";
import { METRIC_CSV_MAX_BYTES, parseMetricCsv } from "@/lib/metrics/csv";
import {
  importReportMetricObservations,
  importWorkspaceMetricCsv,
  loadActiveReportMetricIdentity,
  setWorkspaceCoreMetric,
  type MetricImportSummary,
  type WorkspaceMetricImportSummary,
} from "@/lib/metrics/import";

export type MetricCsvImportActionState =
  | { status: "idle" }
  | {
      status: "error";
      error: string;
      acceptedRows: number;
      rejectedRows: number;
      details: string[];
    }
  | { status: "success"; summary: MetricImportSummary };

export type WorkspaceMetricCsvImportActionState =
  | { status: "idle" }
  | {
      status: "error";
      error: string;
      acceptedRows: number;
      rejectedRows: number;
      details: string[];
    }
  | { status: "success"; summary: WorkspaceMetricImportSummary };

export type CoreMetricSelectionActionState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "success"; isCore: boolean; coreMetricCount: number };

const errorState = (
  error: string,
  acceptedRows = 0,
  rejectedRows = 0,
  details: string[] = [],
): MetricCsvImportActionState => ({ status: "error", error, acceptedRows, rejectedRows, details });

const catalogErrorState = (
  error: string,
  acceptedRows = 0,
  rejectedRows = 0,
  details: string[] = [],
): WorkspaceMetricCsvImportActionState => ({ status: "error", error, acceptedRows, rejectedRows, details });

const selectionErrorState = (error: string): CoreMetricSelectionActionState => ({
  status: "error",
  error,
});

function isMetricUnit(value: unknown): value is "count" | "percent" | "USD" {
  return value === "count" || value === "percent" || value === "USD";
}

/** Add/remove a workspace metric from the shared Core Metrics surface. */
export async function setWorkspaceCoreMetricAction(
  _previous: CoreMetricSelectionActionState,
  formData: FormData,
): Promise<CoreMetricSelectionActionState> {
  const session = await getSession();
  if (!isLocalDemo() && !session.userId) {
    return selectionErrorState("Sign in before changing core metrics.");
  }

  const metricId = formData.get("metricId");
  const isCore = formData.get("isCore");
  if (typeof metricId !== "string" || !metricId) {
    return selectionErrorState("Choose a valid workspace metric.");
  }
  if (isCore !== "true" && isCore !== "false") {
    return selectionErrorState("The core metric selection is invalid.");
  }

  const result = await setWorkspaceCoreMetric(await getServerSupabase(), {
    scopeId: session.workspaceId,
    metricId,
    isCore: isCore === "true",
    authoredBy: session.userId,
  });
  if (!result.ok) return selectionErrorState(result.error);

  revalidatePath("/data-workshop");
  revalidatePath("/onboarding");
  revalidatePath("/", "layout");
  return {
    status: "success",
    isCore: result.isCore,
    coreMetricCount: result.coreMetricCount,
  };
}

/** Create/reuse a workspace metric before report activation. */
export async function importWorkspaceMetricCsvAction(
  _previous: WorkspaceMetricCsvImportActionState,
  formData: FormData,
): Promise<WorkspaceMetricCsvImportActionState> {
  const session = await getSession();
  if (!isLocalDemo() && !session.userId) {
    return catalogErrorState("Sign in before importing a core metric.");
  }

  const rawName = formData.get("metricName");
  const rawUnit = formData.get("unit");
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  const unit = typeof rawUnit === "string" ? rawUnit : "";
  if (!name || name.length > 120) {
    return catalogErrorState("Enter a metric name between 1 and 120 characters.");
  }
  if (!isMetricUnit(unit)) {
    return catalogErrorState("Choose a supported metric unit.");
  }

  const entry = formData.get("csv");
  if (!(entry instanceof File) || !entry.name) return catalogErrorState("Choose one CSV file to import.");
  if (!entry.name.toLowerCase().endsWith(".csv")) return catalogErrorState("Choose a file whose name ends in .csv.");
  if (entry.size > METRIC_CSV_MAX_BYTES) {
    return catalogErrorState(`CSV files must be ${METRIC_CSV_MAX_BYTES / 1024} KB or smaller.`);
  }

  const parsed = parseMetricCsv(new Uint8Array(await entry.arrayBuffer()));
  if (!parsed.ok) {
    return catalogErrorState(parsed.error, parsed.acceptedRows, parsed.rejectedRows, parsed.details);
  }

  const result = await importWorkspaceMetricCsv(await getServerSupabase(), {
    scopeId: session.workspaceId,
    name,
    unit,
    observations: parsed.observations,
    authoredBy: session.userId,
  });
  if (!result.ok) return catalogErrorState(result.error);

  revalidatePath("/data-workshop");
  revalidatePath("/onboarding");
  revalidatePath("/", "layout");
  return { status: "success", summary: result.summary };
}

export async function importActiveReportMetricCsvAction(
  _previous: MetricCsvImportActionState,
  formData: FormData,
): Promise<MetricCsvImportActionState> {
  const session = await getSession();
  if (!isLocalDemo() && !session.userId) {
    return errorState("Sign in before importing metric observations.");
  }
  const entry = formData.get("csv");
  if (!(entry instanceof File) || !entry.name) return errorState("Choose one CSV file to import.");
  if (!entry.name.toLowerCase().endsWith(".csv")) return errorState("Choose a file whose name ends in .csv.");
  if (entry.size > METRIC_CSV_MAX_BYTES) {
    return errorState(`CSV files must be ${METRIC_CSV_MAX_BYTES / 1024} KB or smaller.`);
  }

  const parsed = parseMetricCsv(new Uint8Array(await entry.arrayBuffer()));
  if (!parsed.ok) {
    return errorState(parsed.error, parsed.acceptedRows, parsed.rejectedRows, parsed.details);
  }

  const sb = await getServerSupabase();
  const target = await loadActiveReportMetricIdentity(sb, session.workspaceId);
  if (!target) return errorState("Activate a Decision Report before importing its confirmed metric.");
  const result = await importReportMetricObservations(sb, {
    scopeId: session.workspaceId,
    reportId: target.reportId,
    metricId: target.metricId,
    observations: parsed.observations,
    authoredBy: session.userId,
  });
  if (!result.ok) return errorState(result.error);

  revalidatePath("/data-workshop");
  // Core Metrics is mounted in the shared dashboard layout on every tab.
  revalidatePath("/", "layout");
  return { status: "success", summary: result.summary };
}
