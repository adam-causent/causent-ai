import type { SupabaseClient } from "@supabase/supabase-js";

import { scanDecisionReportGaps } from "./editing.ts";
import {
  validateDecisionReport,
  validateMetricProjection,
  type DecisionReportV1,
  type MetricProjection,
} from "./schema.ts";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DecisionReportPersistenceStatus = "draft" | "report_ready" | "active";
type EditableDecisionReportStatus = Exclude<DecisionReportPersistenceStatus, "active">;

export type DecisionReportActivationPointer = {
  activationId: string;
  decisionId: string;
  predictionId: string;
  metricId: string;
  activatedAt: string;
};

export type PersistedDecisionReport = {
  reportId: string;
  revisionId: string;
  baseRevisionId: string | null;
  status: DecisionReportPersistenceStatus;
  contentHash: string;
  savedAt: string;
  report: DecisionReportV1;
  metricProjection: MetricProjection;
  activation: DecisionReportActivationPointer | null;
};

export type SaveDecisionReportInput = {
  reportId: string | null;
  baseRevisionId: string | null;
  report: DecisionReportV1;
  metricProjection: MetricProjection;
  authoredBy: string | null;
};

export type SaveDecisionReportResult =
  | {
      ok: true;
      saved: PersistedDecisionReport;
      reused: boolean;
    }
  | {
      ok: false;
      code: "validation" | "conflict" | "forbidden" | "database";
      error: string;
      currentRevisionId?: string;
    };

export type LoadDecisionReportResult =
  | { ok: true; saved: PersistedDecisionReport }
  | {
      ok: false;
      code: "validation" | "not_found" | "database";
      error: string;
    };

export type DeleteDecisionReportResult =
  | { ok: true; reportId: string; deletedAt: string; reused: boolean }
  | {
      ok: false;
      code: "validation" | "forbidden" | "database";
      error: string;
    };

type RpcSaveRow = {
  report_id: string;
  revision_id: string;
  base_revision_id: string | null;
  status: EditableDecisionReportStatus;
  content_hash: string;
  reused: boolean;
  saved_at: string;
};

type ReportRow = {
  report_id: string;
  status: DecisionReportPersistenceStatus;
  current_revision_id: string | null;
  active_activation_id: string | null;
  active_decision_id: string | null;
  active_prediction_id: string | null;
  active_metric_id: string | null;
  activated_at: string | null;
};

type RevisionRow = {
  revision_id: string;
  base_revision_id: string | null;
  snapshot: unknown;
  metric_projection: unknown;
  content_hash: string;
  created_at: string;
};

type ActivationRow = {
  activation_id: string;
  report_id: string;
  revision_id: string;
  scope_id: string;
  metric_id: string;
  decision_id: string;
  prediction_id: string;
  activated_at: string;
};

type RpcDeleteRow = {
  report_id: string;
  deleted_at: string;
  reused: boolean;
};

function persistenceStatus(report: DecisionReportV1): EditableDecisionReportStatus {
  return scanDecisionReportGaps(report).length === 0 ? "report_ready" : "draft";
}

function validUuid(value: string | null): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validationFailure(errors: string[]): SaveDecisionReportResult {
  return {
    ok: false,
    code: "validation",
    error: errors.join("; "),
  };
}

function firstRpcRow(value: unknown): RpcSaveRow | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const row = value[0] as Partial<RpcSaveRow>;
  if (
    !validUuid(row.report_id ?? null) ||
    !validUuid(row.revision_id ?? null) ||
    !["draft", "report_ready"].includes(row.status ?? "") ||
    typeof row.content_hash !== "string" ||
    typeof row.reused !== "boolean" ||
    typeof row.saved_at !== "string"
  ) {
    return null;
  }
  return row as RpcSaveRow;
}

function firstDeleteRpcRow(value: unknown): RpcDeleteRow | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const row = value[0] as Partial<RpcDeleteRow>;
  if (
    !validUuid(row.report_id ?? null) ||
    typeof row.deleted_at !== "string" ||
    Number.isNaN(Date.parse(row.deleted_at)) ||
    typeof row.reused !== "boolean"
  ) {
    return null;
  }
  return row as RpcDeleteRow;
}

export async function deleteDecisionReport(
  sb: SupabaseClient,
  scopeId: string,
  reportId: string,
  authoredBy: string | null,
): Promise<DeleteDecisionReportResult> {
  if (
    !validUuid(scopeId) ||
    !validUuid(reportId) ||
    (authoredBy !== null && !validUuid(authoredBy))
  ) {
    return { ok: false, code: "validation", error: "Report address is invalid." };
  }
  const response = await sb.rpc("delete_decision_report_v1", {
    p_scope_id: scopeId,
    p_report_id: reportId,
    p_authored_by: authoredBy,
  });
  if (response.error) {
    if (response.error.code === "42501") {
      return {
        ok: false,
        code: "forbidden",
        error: "This report is unavailable in the current workspace.",
      };
    }
    return { ok: false, code: "database", error: response.error.message };
  }
  const row = firstDeleteRpcRow(response.data);
  if (!row) {
    return { ok: false, code: "database", error: "The database returned an invalid deletion receipt." };
  }
  return {
    ok: true,
    reportId: row.report_id,
    deletedAt: row.deleted_at,
    reused: row.reused,
  };
}

export async function saveDecisionReport(
  sb: SupabaseClient,
  scopeId: string,
  input: SaveDecisionReportInput,
): Promise<SaveDecisionReportResult> {
  if (!validUuid(scopeId)) return validationFailure(["Workspace ID is invalid."]);
  if (input.reportId !== null && !validUuid(input.reportId)) {
    return validationFailure(["Report ID is invalid."]);
  }
  if (input.reportId === null && input.baseRevisionId !== null) {
    return validationFailure(["A new report cannot have a base revision."]);
  }
  if (input.reportId !== null && !validUuid(input.baseRevisionId)) {
    return validationFailure(["Saved reports require a valid base revision."]);
  }
  if (input.authoredBy !== null && !validUuid(input.authoredBy)) {
    return validationFailure(["Author ID is invalid."]);
  }

  const reportValidation = validateDecisionReport(input.report);
  const projectionValidation = validateMetricProjection(input.metricProjection);
  if (!reportValidation.success || !projectionValidation.success) {
    return validationFailure([
      ...(reportValidation.success ? [] : reportValidation.errors),
      ...(projectionValidation.success ? [] : projectionValidation.errors),
    ]);
  }

  const status = persistenceStatus(reportValidation.data);
  const common = {
    p_title: reportValidation.data.title,
    p_status: status,
    p_snapshot: reportValidation.data,
    p_metric_projection: projectionValidation.data,
    p_authored_by: input.authoredBy,
  };

  const response = input.reportId === null
    ? await sb.rpc("create_decision_report_v1", {
        p_scope_id: scopeId,
        ...common,
      })
    : await sb.rpc("append_decision_report_revision_v1", {
        p_report_id: input.reportId,
        p_base_revision_id: input.baseRevisionId,
        ...common,
      });

  if (response.error) {
    if (response.error.code === "PT409" && response.error.message.includes("STALE_REVISION")) {
      const currentRevisionId = validUuid(response.error.details ?? null)
        ? response.error.details
        : undefined;
      return {
        ok: false,
        code: "conflict",
        error: "This report changed in another tab. Reload the saved version before trying again.",
        currentRevisionId,
      };
    }
    if (response.error.code === "PT409" && response.error.message.includes("REPORT_ALREADY_ACTIVE")) {
      return {
        ok: false,
        code: "conflict",
        error: "This report is already active and can no longer be edited.",
      };
    }
    if (response.error.code === "42501") {
      return {
        ok: false,
        code: "forbidden",
        error: "This report is unavailable in the current workspace.",
      };
    }
    return { ok: false, code: "database", error: response.error.message };
  }

  const row = firstRpcRow(response.data);
  if (!row) {
    return {
      ok: false,
      code: "database",
      error: "The database returned an invalid report revision.",
    };
  }

  return {
    ok: true,
    reused: row.reused,
    saved: {
      reportId: row.report_id,
      revisionId: row.revision_id,
      baseRevisionId: row.base_revision_id,
      status: row.status,
      contentHash: row.content_hash,
      savedAt: row.saved_at,
      report: reportValidation.data,
      metricProjection: projectionValidation.data,
      activation: null,
    },
  };
}

export async function loadDecisionReport(
  sb: SupabaseClient,
  scopeId: string,
  reportId: string,
): Promise<LoadDecisionReportResult> {
  if (!validUuid(scopeId) || !validUuid(reportId)) {
    return { ok: false, code: "validation", error: "Report address is invalid." };
  }

  const reportResponse = await sb
    .from("decision_reports")
    .select(
      "report_id, status, current_revision_id, active_activation_id, active_decision_id, " +
        "active_prediction_id, active_metric_id, activated_at",
    )
    .eq("scope_id", scopeId)
    .eq("report_id", reportId)
    .is("deleted_at", null)
    .maybeSingle();
  if (reportResponse.error) {
    return { ok: false, code: "database", error: reportResponse.error.message };
  }
  if (!reportResponse.data) {
    return { ok: false, code: "not_found", error: "Saved report not found." };
  }

  const reportRow = reportResponse.data as unknown as ReportRow;
  if (!["draft", "report_ready", "active"].includes(reportRow.status)) {
    return { ok: false, code: "database", error: "Saved report has an invalid status." };
  }
  if (!validUuid(reportRow.current_revision_id)) {
    return { ok: false, code: "database", error: "Saved report has no current revision." };
  }

  const revisionResponse = await sb
    .from("decision_report_revisions")
    .select(
      "revision_id, base_revision_id, snapshot, metric_projection, content_hash, created_at",
    )
    .eq("scope_id", scopeId)
    .eq("report_id", reportId)
    .eq("revision_id", reportRow.current_revision_id)
    .maybeSingle();
  if (revisionResponse.error) {
    return { ok: false, code: "database", error: revisionResponse.error.message };
  }
  if (!revisionResponse.data) {
    return { ok: false, code: "not_found", error: "Saved report revision not found." };
  }

  const revisionRow = revisionResponse.data as RevisionRow;
  const reportValidation = validateDecisionReport(revisionRow.snapshot);
  const projectionValidation = validateMetricProjection(revisionRow.metric_projection);
  if (!reportValidation.success || !projectionValidation.success) {
    return {
      ok: false,
      code: "database",
      error: "Saved report revision failed runtime validation.",
    };
  }

  let activation: DecisionReportActivationPointer | null = null;
  if (reportRow.status === "active") {
    if (
      !validUuid(reportRow.active_activation_id) ||
      !validUuid(reportRow.active_decision_id) ||
      !validUuid(reportRow.active_prediction_id) ||
      !validUuid(reportRow.active_metric_id) ||
      typeof reportRow.activated_at !== "string" ||
      Number.isNaN(Date.parse(reportRow.activated_at))
    ) {
      return { ok: false, code: "database", error: "Active report pointers are invalid." };
    }

    const activationResponse = await sb
      .from("decision_report_activations")
      .select(
        "activation_id, report_id, revision_id, scope_id, metric_id, decision_id, " +
          "prediction_id, activated_at",
      )
      .eq("scope_id", scopeId)
      .eq("report_id", reportId)
      .eq("revision_id", revisionRow.revision_id)
      .eq("activation_id", reportRow.active_activation_id)
      .maybeSingle();
    if (activationResponse.error) {
      return { ok: false, code: "database", error: activationResponse.error.message };
    }
    const activationRow = activationResponse.data as ActivationRow | null;
    if (
      !activationRow ||
      activationRow.report_id !== reportId ||
      activationRow.revision_id !== revisionRow.revision_id ||
      activationRow.scope_id !== scopeId ||
      activationRow.metric_id !== reportRow.active_metric_id ||
      activationRow.decision_id !== reportRow.active_decision_id ||
      activationRow.prediction_id !== reportRow.active_prediction_id ||
      Date.parse(activationRow.activated_at) !== Date.parse(reportRow.activated_at)
    ) {
      return {
        ok: false,
        code: "database",
        error: "Active report pointers do not match the activation audit.",
      };
    }
    activation = {
      activationId: reportRow.active_activation_id,
      decisionId: reportRow.active_decision_id,
      predictionId: reportRow.active_prediction_id,
      metricId: reportRow.active_metric_id,
      activatedAt: reportRow.activated_at,
    };
  }

  return {
    ok: true,
    saved: {
      reportId: reportRow.report_id,
      revisionId: revisionRow.revision_id,
      baseRevisionId: revisionRow.base_revision_id,
      status: reportRow.status,
      contentHash: revisionRow.content_hash,
      savedAt: revisionRow.created_at,
      report: reportValidation.data,
      metricProjection: projectionValidation.data,
      activation,
    },
  };
}
