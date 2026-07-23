"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DecisionReportEditor } from "@/components/decision-report/DecisionReportEditor";
import {
  generateDecisionReportAction,
  type GenerateDecisionReportActionResult,
} from "@/app/(onboarding)/onboarding/decision-report-actions";
import { GUMMY_ALPHA_GOLDEN_EXAMPLE } from "@/lib/decision-reports/fixtures/gummy-alpha";
import type { DecisionReportPersistenceStatus } from "@/lib/decision-reports/persistence";
import type { DecisionReportActivationPointer } from "@/lib/decision-reports/persistence";
import type { ReportActivationMetric } from "@/lib/decision-reports/materialization";
import type { DecisionReportV1, MetricProjection } from "@/lib/decision-reports/schema";
import type { ReportAssetView } from "@/lib/decision-reports/assets";

type GeneratedReport = Extract<
  GenerateDecisionReportActionResult,
  { ok: true }
>["generation"];

export type InitialSavedDecisionReport = {
  report: DecisionReportV1;
  metricProjection: MetricProjection;
  workspaceName: string;
  projectName: string;
  persistence: {
    reportId: string;
    revisionId: string;
    status: DecisionReportPersistenceStatus;
    savedAt: string;
    activation: DecisionReportActivationPointer | null;
  };
  asset: ReportAssetView | null;
};

type ReportDraft = {
  report: DecisionReportV1;
  metricProjection: MetricProjection;
  workspaceName: string;
  projectName: string;
  generationMeta?: {
    mode: "live" | "fixture" | "fallback";
    warning: string | null;
    latencyMs: number;
    totalTokens: number | null;
  };
  persistence?: InitialSavedDecisionReport["persistence"];
  asset?: ReportAssetView | null;
};

export function DecisionReportOnboarding({
  initialSavedReport = null,
  initialLoadError = null,
  activationMetrics = [],
}: {
  initialSavedReport?: InitialSavedDecisionReport | null;
  initialLoadError?: string | null;
  activationMetrics?: ReportActivationMetric[];
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(GUMMY_ALPHA_GOLDEN_EXAMPLE.initialPrompt);
  const [draft, setDraft] = useState<ReportDraft | null>(() =>
    initialSavedReport ? { ...initialSavedReport } : null,
  );
  const [error, setError] = useState<string | null>(initialLoadError);
  const [isPending, startTransition] = useTransition();

  function generateReport() {
    setError(null);
    startTransition(async () => {
      const result = await generateDecisionReportAction(prompt);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const generated: GeneratedReport = result.generation;
      setDraft({
        report: generated.report,
        metricProjection: generated.metricProjection,
        workspaceName: generated.workspaceName,
        projectName: generated.projectName,
        generationMeta: {
          mode: generated.mode,
          warning: generated.warning,
          latencyMs: generated.telemetry.latencyMs,
          totalTokens: generated.telemetry.totalTokens,
        },
      });
    });
  }

  if (draft) {
    return (
      <div id="report-top">
        <DecisionReportEditor
          initialReport={draft.report}
          projection={draft.metricProjection}
          workspaceName={draft.workspaceName}
          projectName={draft.projectName}
          generationMeta={draft.generationMeta}
          initialPersistence={draft.persistence}
          initialAsset={draft.asset ?? null}
          activationMetrics={activationMetrics}
          onStartOver={() => {
            setDraft(null);
            setError(null);
            router.replace("/onboarding", { scroll: false });
          }}
        />
      </div>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col py-6 sm:py-12">
      <div className="mb-8">
        <div className="mb-4 flex items-center gap-2 text-[11px] font-medium text-[var(--text-muted)]">
          <span className="rounded-full border border-[var(--border)] bg-white px-2.5 py-1">Orbit</span>
          <span aria-hidden>→</span>
          <span>New project</span>
        </div>
        <h1 className="max-w-2xl text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] text-[var(--text)] sm:text-[38px]">
          What are you building?
        </h1>
        <p className="mt-3 max-w-2xl text-[14px] leading-6 text-[var(--text-muted)]">
          Describe the decision, supporting evidence, and resources already in your plan. Causent will turn them into an editable Decision Report.
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg shadow-slate-200/50 sm:p-5">
        <label className="sr-only" htmlFor="project-brief">
          Project brief
        </label>
        <textarea
          id="project-brief"
          autoFocus
          className="min-h-56 w-full resize-y bg-transparent text-[14px] leading-7 text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)]"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What are you building? What supports the decision? What resources do you already have?"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <p className="max-w-md text-[11px] leading-5 text-[var(--text-muted)]">
            Causent labels supplied facts, AI inferences, suggestions, and missing information separately. It will not invent owners, costs, or metric values.
          </p>
          <button
            type="button"
            className="rounded-lg bg-[var(--text)] px-5 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            disabled={prompt.trim().length < 20 || isPending}
            onClick={generateReport}
          >
            {isPending ? "Generating report…" : "Generate Decision Report"}
          </button>
        </div>
        {error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          ["01", "Decision", "The change, context, and problem"],
          ["02", "Evidence", "Signals, mechanism, and metric"],
          ["03", "Implementation", "Actions, owners, and governance"],
        ].map(([number, title, description]) => (
          <div key={number} className="rounded-xl border border-[var(--border)] bg-white/60 p-4">
            <p className="text-[10px] font-semibold text-[var(--brand-teal)]">{number}</p>
            <p className="mt-2 text-[13px] font-semibold text-[var(--text)]">{title}</p>
            <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">{description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
