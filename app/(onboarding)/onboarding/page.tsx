import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingFunnel } from "@/components/onboarding/OnboardingFunnel";
import {
  DecisionReportOnboarding,
  type InitialSavedDecisionReport,
} from "@/components/decision-report/DecisionReportOnboarding";
import { getSession } from "@/lib/auth/session";
import { getScope } from "@/lib/data/scope";
import { loadDecisionReport, UUID_PATTERN } from "@/lib/decision-reports/persistence";
import {
  loadReportActivationMetrics,
  type ReportActivationMetric,
} from "@/lib/decision-reports/materialization";
import { getServerSupabase, isLocalDemo } from "@/lib/supabase-server";
import { loadAttachedReportAsset } from "@/lib/decision-reports/assets";
import {
  isDecisionReportRolloutEnabled,
  resolveOnboardingFlow,
} from "@/lib/decision-reports/rollout";

// Slice 5 of the AI-assisted onboarding: a reviewed saved revision can be
// explicitly activated into one decision, one human prediction, and selected
// planned actions through a checked idempotent RPC.

export const metadata: Metadata = {
  title: "Causent — Build a Decision Report",
};

// The funnel writes on every visit path; never prerender it at build time.
export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{
    report?: string | string[];
    flow?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const requestedReportId = Array.isArray(params.report) ? params.report[0] : params.report;
  const requestedFlow = Array.isArray(params.flow) ? params.flow[0] : params.flow;
  let initialSavedReport: InitialSavedDecisionReport | null = null;
  let initialLoadError: string | null = null;
  let activationMetrics: ReportActivationMetric[] = [];
  const session = await getSession();
  const sb = await getServerSupabase();
  const rolloutEnabled = await isDecisionReportRolloutEnabled(
    sb,
    session.workspaceId,
    session.userId,
    isLocalDemo() && process.env.CAUSENT_DECISION_REPORT_LOCAL_ROLLOUT === "1",
  ).catch(() => false);
  const flow = resolveOnboardingFlow({
    requestedFlow: requestedFlow ?? null,
    hasSavedReport: Boolean(requestedReportId),
    rolloutEnabled,
  });

  if (!requestedReportId && requestedFlow !== flow) {
    redirect(`/onboarding?flow=${flow}`);
  }

  if (flow === "legacy") {
    return <OnboardingFunnel />;
  }

  if (isLocalDemo() || session.userId) {
    activationMetrics = await loadReportActivationMetrics(
      sb,
      session.workspaceId,
    ).catch(() => []);
  }

  if (requestedReportId) {
    if (!UUID_PATTERN.test(requestedReportId)) {
      initialLoadError = "That saved-report address is invalid.";
    } else {
      if (!isLocalDemo() && !session.userId) {
        initialLoadError = "Sign in to open this saved report.";
      } else {
        const [loaded, scope, asset] = await Promise.all([
          loadDecisionReport(
            sb,
            session.workspaceId,
            requestedReportId,
          ),
          getScope(),
          loadAttachedReportAsset(sb, requestedReportId),
        ]).catch(() => [null, null, null] as const);

        if (loaded?.ok && scope) {
          initialSavedReport = {
            report: loaded.saved.report,
            metricProjection: loaded.saved.metricProjection,
            workspaceName: scope.project,
            projectName: scope.workspace,
            persistence: {
              reportId: loaded.saved.reportId,
              revisionId: loaded.saved.revisionId,
              status: loaded.saved.status,
              savedAt: loaded.saved.savedAt,
              activation: loaded.saved.activation,
            },
            asset: asset ?? null,
          };
        } else {
          initialLoadError = loaded && !loaded.ok
            ? loaded.error
            : "Causent could not load that saved report.";
        }
      }
    }
  }

  return (
    <DecisionReportOnboarding
      initialSavedReport={initialSavedReport}
      initialLoadError={initialLoadError}
      activationMetrics={activationMetrics}
    />
  );
}
