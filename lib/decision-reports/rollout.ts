import type { SupabaseClient } from "@supabase/supabase-js";

export type OnboardingFlow = "legacy" | "decision-report";

export function resolveOnboardingFlow(input: {
  requestedFlow: string | null;
  hasSavedReport: boolean;
  rolloutEnabled: boolean;
}): OnboardingFlow {
  if (input.hasSavedReport) return "decision-report";
  // A legacy start is sticky across refresh, Back, and later rollout changes.
  if (input.requestedFlow === "legacy") return "legacy";
  return input.rolloutEnabled ? "decision-report" : "legacy";
}

export async function isDecisionReportRolloutEnabled(
  sb: SupabaseClient,
  scopeId: string,
  userId: string | null,
  localDemoEnabled = false,
): Promise<boolean> {
  if (!userId) return localDemoEnabled;

  const response = await sb
    .from("decision_report_rollouts")
    .select("enabled")
    .eq("scope_id", scopeId)
    .eq("user_id", userId)
    .maybeSingle();

  if (response.error) throw response.error;
  return response.data?.enabled === true;
}
