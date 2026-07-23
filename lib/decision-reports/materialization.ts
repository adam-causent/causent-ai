import type { SupabaseClient } from "@supabase/supabase-js";

import {
  validateReportActivationInputV1,
  type ReportActivationInputV1,
} from "./activation.ts";
import { UUID_PATTERN } from "./persistence.ts";

export type ReportActivationMetric = {
  metricId: string;
  name: string;
  source: string;
  unit: string | null;
  hasObservations: boolean;
  isCore: boolean;
};

export type MaterializedReportActivation = {
  activationId: string;
  decisionId: string;
  predictionId: string;
  actionIds: string[];
  reused: boolean;
  activatedAt: string;
};

export type MaterializeReportActivationResult =
  | { ok: true; activation: MaterializedReportActivation }
  | {
      ok: false;
      code: "validation" | "conflict" | "forbidden" | "database";
      error: string;
      activationId?: string;
    };

type ActivationRpcRow = {
  activation_id: string;
  decision_id: string;
  prediction_id: string;
  action_ids: string[];
  reused: boolean;
  activated_at: string;
};

type MetricRow = {
  metric_id: string;
  name: string;
  source: string;
  unit: string | null;
  is_core: boolean;
};

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function firstActivationRow(value: unknown): ActivationRpcRow | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0] as Partial<ActivationRpcRow>;
  if (
    !validUuid(row.activation_id) ||
    !validUuid(row.decision_id) ||
    !validUuid(row.prediction_id) ||
    !Array.isArray(row.action_ids) ||
    row.action_ids.length < 1 ||
    row.action_ids.length > 3 ||
    row.action_ids.some((id) => !validUuid(id)) ||
    new Set(row.action_ids).size !== row.action_ids.length ||
    typeof row.reused !== "boolean" ||
    typeof row.activated_at !== "string" ||
    Number.isNaN(Date.parse(row.activated_at))
  ) {
    return null;
  }
  return row as ActivationRpcRow;
}

export async function loadReportActivationMetrics(
  sb: SupabaseClient,
  scopeId: string,
): Promise<ReportActivationMetric[]> {
  if (!validUuid(scopeId)) return [];
  const response = await sb
    .from("metrics")
    .select("metric_id, name, source, unit, is_core")
    .eq("scope_id", scopeId)
    .order("name", { ascending: true });
  if (response.error) throw response.error;

  const rows = ((response.data ?? []) as MetricRow[]).filter(
    (row) => validUuid(row.metric_id) && typeof row.name === "string" && row.name.trim(),
  );
  const observationChecks = await Promise.all(rows.map((row) =>
    sb
      .from("metric_observations")
      .select("metric_id", { count: "exact", head: true })
      .eq("metric_id", row.metric_id)
      .limit(1),
  ));
  for (const check of observationChecks) {
    if (check.error) throw check.error;
  }

  return rows.flatMap((row, index) => {
    if (!validUuid(row.metric_id) || typeof row.name !== "string" || !row.name.trim()) {
      return [];
    }
    return [{
      metricId: row.metric_id,
      name: row.name,
      source: row.source,
      unit: row.unit,
      hasObservations: (observationChecks[index].count ?? 0) > 0,
      isCore: row.is_core === true,
    }];
  });
}

export async function materializeReportActivation(
  sb: SupabaseClient,
  input: ReportActivationInputV1,
  activatedBy: string | null,
): Promise<MaterializeReportActivationResult> {
  const validation = validateReportActivationInputV1(input);
  if (!validation.success) {
    return { ok: false, code: "validation", error: validation.errors.join("; ") };
  }
  if (activatedBy !== null && !validUuid(activatedBy)) {
    return { ok: false, code: "validation", error: "Activation author is invalid." };
  }

  const response = await sb.rpc("activate_decision_report_v1", {
    p_report_id: validation.data.reportId,
    p_revision_id: validation.data.revisionId,
    p_metric_id: validation.data.confirmedMetricId,
    p_prediction_direction: validation.data.prediction.direction,
    p_prediction_magnitude_pct_mean: validation.data.prediction.magnitudePctMean,
    p_prediction_resolution_date: validation.data.prediction.resolutionDate,
    p_selected_action_source_ids: validation.data.selectedActionSourceItemIds,
    p_activated_by: activatedBy,
  });

  if (response.error) {
    if (response.error.code === "PT409" && response.error.message.includes("REPORT_ALREADY_ACTIVE")) {
      return {
        ok: false,
        code: "conflict",
        error: "This report is already active with different activation choices.",
        activationId: validUuid(response.error.details) ? response.error.details : undefined,
      };
    }
    if (response.error.code === "42501") {
      return {
        ok: false,
        code: "forbidden",
        error: "This report or metric is unavailable in the current workspace.",
      };
    }
    if (response.error.code === "22023") {
      return { ok: false, code: "validation", error: response.error.message };
    }
    return { ok: false, code: "database", error: response.error.message };
  }

  const row = firstActivationRow(response.data);
  if (!row) {
    return {
      ok: false,
      code: "database",
      error: "The database returned an invalid report activation.",
    };
  }

  return {
    ok: true,
    activation: {
      activationId: row.activation_id,
      decisionId: row.decision_id,
      predictionId: row.prediction_id,
      actionIds: row.action_ids,
      reused: row.reused,
      activatedAt: row.activated_at,
    },
  };
}
