"use client";

import { useState } from "react";
import { ProvenanceLegend } from "@/components/decision-report/ClaimEditor";
import { DecisionSection } from "@/components/decision-report/DecisionSection";
import { ImplementationSection } from "@/components/decision-report/ImplementationSection";
import { SupportingEvidenceSection } from "@/components/decision-report/SupportingEvidenceSection";
import type {
  Claim,
  DecisionReportV1,
  MetricProjection,
} from "@/lib/decision-reports/schema";
import { cloneDecisionReport } from "@/lib/decision-reports/schema";

function editableClaims(report: DecisionReportV1): Claim[] {
  return [
    ...report.decision.decision,
    ...report.decision.background,
    ...report.decision.problem,
    ...report.supportingEvidence.factors,
    ...report.supportingEvidence.metricMechanism,
    ...report.supportingEvidence.alternatives,
    ...report.supportingEvidence.precedent,
    ...report.implementation.actionPlanSummary,
    ...report.implementation.cost,
    ...report.implementation.customers,
    ...report.implementation.stakeholders,
    ...report.implementation.governance.allowedDataSources,
    ...report.implementation.governance.approvedModelNotes,
    ...report.implementation.actions.flatMap((action) => [
      ...action.summary,
      ...(action.owner ? [action.owner] : []),
    ]),
  ];
}

export function DecisionReportEditor({
  initialReport,
  projection,
  workspaceName,
  projectName,
  generationMeta,
  onStartOver,
}: {
  initialReport: DecisionReportV1;
  projection: MetricProjection;
  workspaceName: string;
  projectName: string;
  generationMeta?: {
    mode: "live" | "fixture" | "fallback";
    warning: string | null;
    latencyMs: number;
    totalTokens: number | null;
  };
  onStartOver: () => void;
}) {
  const [report, setReport] = useState(() => cloneDecisionReport(initialReport));

  function updateClaim(claimId: string, text: string) {
    setReport((current) => {
      const next = cloneDecisionReport(current);
      const target = editableClaims(next).find((claim) => claim.id === claimId);
      if (!target) return current;

      target.text = text;
      target.status = text.trim() === "" ? "missing" : "user_confirmed";
      target.sourceChunkIds = [];
      return next;
    });
  }

  function updateActionTitle(sourceItemId: string, title: string) {
    setReport((current) => {
      const next = cloneDecisionReport(current);
      const action = next.implementation.actions.find((item) => item.sourceItemId === sourceItemId);
      if (action) action.title = title;
      return next;
    });
  }

  function updateActionOwner(sourceItemId: string, text: string) {
    setReport((current) => {
      const next = cloneDecisionReport(current);
      const action = next.implementation.actions.find((item) => item.sourceItemId === sourceItemId);
      if (!action) return current;
      action.owner = text.trim()
        ? {
            id: `${sourceItemId}-owner`,
            text,
            status: "user_confirmed",
            sourceChunkIds: [],
          }
        : null;
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3 pb-16">
      {generationMeta?.warning ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-900" role="status">
          {generationMeta.warning}
        </div>
      ) : null}
      <header className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm shadow-slate-200/40 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-[var(--text-muted)]">
              <span>{workspaceName}</span>
              <span aria-hidden>·</span>
              <span>{projectName}</span>
              <span className="rounded-full bg-teal-50 px-2 py-0.5 font-semibold text-[var(--pos)]">
                Draft
              </span>
              {generationMeta ? (
                <span>
                  {generationMeta.mode === "live" ? "AI generated" : generationMeta.mode === "fixture" ? "Fixture mode" : "Safe fallback"}
                  {generationMeta.mode === "live"
                    ? ` · ${(generationMeta.latencyMs / 1000).toFixed(1)}s${generationMeta.totalTokens ? ` · ${generationMeta.totalTokens.toLocaleString()} tokens` : ""}`
                    : ""}
                </span>
              ) : null}
            </div>
            <input
              className="mt-2 w-full bg-transparent text-[24px] font-semibold leading-tight text-[var(--text)] outline-none sm:text-[28px]"
              aria-label="Report title"
              value={report.title}
              onChange={(event) => setReport((current) => ({ ...current, title: event.target.value }))}
            />
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[var(--text-muted)]">
              One brief produced a decision, evidence map, metric hypothesis, and action plan. Every field remains yours to edit.
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            onClick={onStartOver}
          >
            Edit
          </button>
        </div>
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            How to read this draft
          </p>
          <ProvenanceLegend />
        </div>
      </header>

      <DecisionSection decision={report.decision} onClaimChange={updateClaim} />
      <SupportingEvidenceSection
        evidence={report.supportingEvidence}
        projection={projection}
        onClaimChange={updateClaim}
      />
      <ImplementationSection
        implementation={report.implementation}
        onClaimChange={updateClaim}
        onActionTitleChange={updateActionTitle}
        onActionOwnerChange={updateActionOwner}
        onDataClassificationChange={(value) =>
          setReport((current) => ({
            ...current,
            implementation: {
              ...current.implementation,
              governance: {
                ...current.implementation.governance,
                dataClassification: value,
              },
            },
          }))
        }
      />

      <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-white/95 px-4 py-3 shadow-lg shadow-slate-300/30 backdrop-blur">
        <p className="text-[11px] text-[var(--text-muted)]">
          Prototype draft · changes live only in this browser session
        </p>
        <button
          type="button"
          className="rounded-lg bg-[var(--text)] px-4 py-2 text-[12px] font-semibold text-white"
          onClick={() => document.getElementById("report-top")?.scrollIntoView({ behavior: "smooth" })}
        >
          Review from the top
        </button>
      </div>
    </div>
  );
}
