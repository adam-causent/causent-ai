import type { Metadata } from "next";
import { DecisionReportOnboarding } from "@/components/decision-report/DecisionReportOnboarding";

// Slice 2 of the AI-assisted onboarding: one bounded brief generates an
// editable, three-section Decision Report through a server-only model seam.
// Persistence remains deliberately outside this route until the report
// experience is validated with a partner.

export const metadata: Metadata = {
  title: "Causent — Build a Decision Report",
};

// The funnel writes on every visit path; never prerender it at build time.
export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  return <DecisionReportOnboarding />;
}
