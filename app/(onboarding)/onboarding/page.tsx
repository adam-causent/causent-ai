import type { Metadata } from "next";
import { OnboardingFunnel } from "@/components/onboarding/OnboardingFunnel";

// The cold-start funnel, Steps 2-4 (C2/#15): paste -> structured decision card
// + interrogation -> declared metric -> committed prediction. No connector
// wall — the earned connector ask (Steps 5-6) is C3. The page is a thin shell;
// all state lives in the client wizard and all writes go through the
// server actions (scoped by lib/auth/session.ts).

export const metadata: Metadata = {
  title: "Causent — What are you about to build?",
};

// The funnel writes on every visit path; never prerender it at build time.
export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  return <OnboardingFunnel />;
}
