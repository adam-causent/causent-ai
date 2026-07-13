import { Logo } from "@/components/shell/Logo";

// Minimal onboarding shell (C2/#15): logo + a centered column, no dashboard
// chrome — the funnel is the whole screen until the prediction is committed.
// Step 1 (auth landing) is issue #5; its post-OAuth redirect points here.

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)]">
      <header className="flex h-14 items-center border-b border-[var(--border)] bg-[var(--surface)] px-6">
        <Logo />
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-10">
        {children}
      </main>
    </div>
  );
}
