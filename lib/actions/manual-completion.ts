import type { SupabaseClient } from "@supabase/supabase-js";

import { UUID_PATTERN } from "../decision-reports/persistence.ts";

export type ManualActionCompletion = {
  actionId: string;
  completedOn: string;
  explanation: string;
  reused: boolean;
};

export type ManualActionCompletionResult =
  | { ok: true; completion: ManualActionCompletion }
  | { ok: false; code: "validation" | "forbidden" | "database"; error: string };

type CompletionRpcRow = {
  completed_action_id: string;
  completed_on: string;
  explanation: string;
  reused: boolean;
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return normalized.getUTCFullYear() === year
    && normalized.getUTCMonth() === month - 1
    && normalized.getUTCDate() === day;
}

export async function completeManualAction(
  sb: SupabaseClient,
  input: {
    scopeId: string;
    actionId: string;
    completedOn: string;
    explanation: string;
    authoredBy: string | null;
  },
): Promise<ManualActionCompletionResult> {
  const explanation = input.explanation.trim().replace(/\s+/g, " ");
  if (
    !UUID_PATTERN.test(input.scopeId) ||
    !UUID_PATTERN.test(input.actionId) ||
    !validDate(input.completedOn) ||
    !explanation ||
    explanation.length > 1000 ||
    /[\u0000-\u001f\u007f]/.test(explanation) ||
    (input.authoredBy !== null && !UUID_PATTERN.test(input.authoredBy))
  ) {
    return {
      ok: false,
      code: "validation",
      error: "Choose a valid completion date and enter an explanation of up to 1000 characters.",
    };
  }

  const response = await sb.rpc("complete_manual_action_v1", {
    p_scope_id: input.scopeId,
    p_action_id: input.actionId,
    p_completed_on: input.completedOn,
    p_explanation: explanation,
    p_authored_by: input.authoredBy,
  });
  if (response.error) {
    if (response.error.code === "42501") {
      return { ok: false, code: "forbidden", error: "This action is unavailable in the current workspace." };
    }
    if (response.error.code === "22023") {
      return { ok: false, code: "validation", error: response.error.message };
    }
    return { ok: false, code: "database", error: response.error.message };
  }

  if (!Array.isArray(response.data) || response.data.length !== 1) {
    return { ok: false, code: "database", error: "The database returned an invalid completion record." };
  }
  const row = response.data[0] as Partial<CompletionRpcRow>;
  if (
    typeof row.completed_action_id !== "string" ||
    !UUID_PATTERN.test(row.completed_action_id) ||
    typeof row.completed_on !== "string" ||
    !validDate(row.completed_on) ||
    typeof row.explanation !== "string" ||
    typeof row.reused !== "boolean"
  ) {
    return { ok: false, code: "database", error: "The database returned an invalid completion record." };
  }

  return {
    ok: true,
    completion: {
      actionId: row.completed_action_id,
      completedOn: row.completed_on,
      explanation: row.explanation,
      reused: row.reused,
    },
  };
}
