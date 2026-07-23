"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveDecisionReportAction,
  type SaveDecisionReportActionResult,
} from "@/app/(onboarding)/onboarding/decision-report-persistence-actions";
import {
  removeDecisionReportImageAction,
  uploadDecisionReportImageAction,
} from "@/app/(onboarding)/onboarding/decision-report-asset-actions";
import { ProvenanceLegend } from "@/components/decision-report/ClaimEditor";
import { DecisionSection } from "@/components/decision-report/DecisionSection";
import { ImplementationSection } from "@/components/decision-report/ImplementationSection";
import { ReportCompletionPanel } from "@/components/decision-report/ReportCompletionPanel";
import { ReportActivationPanel } from "@/components/decision-report/ReportActivationPanel";
import { SupportingEvidenceSection } from "@/components/decision-report/SupportingEvidenceSection";
import {
  applyReportEditCommand,
  createGapAnswerCommand,
  scanDecisionReportGaps,
  type DecisionReportGap,
  type ReportEditCommandV1,
} from "@/lib/decision-reports/editing";
import type { DecisionReportV1, MetricProjection } from "@/lib/decision-reports/schema";
import { cloneDecisionReport } from "@/lib/decision-reports/schema";
import type { DecisionReportPersistenceStatus } from "@/lib/decision-reports/persistence";
import type { DecisionReportActivationPointer } from "@/lib/decision-reports/persistence";
import type { ReportActivationMetric } from "@/lib/decision-reports/materialization";
import type { ReportAssetView } from "@/lib/decision-reports/assets";

type ReportPersistenceState = {
  reportId: string;
  revisionId: string;
  status: DecisionReportPersistenceStatus;
  savedAt: string;
  activation: DecisionReportActivationPointer | null;
};

export function DecisionReportEditor({
  initialReport,
  projection,
  workspaceName,
  projectName,
  generationMeta,
  initialPersistence,
  initialAsset,
  activationMetrics,
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
  initialPersistence?: ReportPersistenceState;
  initialAsset?: ReportAssetView | null;
  activationMetrics: ReportActivationMetric[];
  onStartOver: () => void;
}) {
  const router = useRouter();
  const [report, setReport] = useState(() => cloneDecisionReport(initialReport));
  const [editError, setEditError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [asset, setAsset] = useState<ReportAssetView | null>(initialAsset ?? null);
  const [persistence, setPersistence] = useState<ReportPersistenceState | null>(
    initialPersistence ?? null,
  );
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(() =>
    initialPersistence ? JSON.stringify(initialReport) : null,
  );
  const [isSaving, startSaving] = useTransition();
  const [isChangingAsset, startChangingAsset] = useTransition();
  const gaps = scanDecisionReportGaps(report);
  const ready = gaps.length === 0;
  const hasUnsavedChanges = savedSnapshot !== JSON.stringify(report);
  const reportIsActive = persistence?.status === "active";

  function dispatchEdit(command: ReportEditCommandV1): boolean {
    if (reportIsActive) return false;
    const result = applyReportEditCommand(report, command);
    if (!result.ok) {
      setEditError(result.error);
      return false;
    }
    setEditError(null);
    setReport(result.report);
    return true;
  }

  function updateClaim(claimId: string, text: string) {
    dispatchEdit({ type: "replace_claim_text", claimId, text });
  }

  function updateActionTitle(sourceItemId: string, title: string) {
    dispatchEdit({ type: "edit_action_title", sourceItemId, title });
  }

  function updateActionSummary(sourceItemId: string, text: string) {
    dispatchEdit({ type: "edit_action_summary", sourceItemId, text });
  }

  function updateActionOwner(sourceItemId: string, text: string) {
    dispatchEdit({ type: "edit_action_owner", sourceItemId, text });
  }

  function focusGap(gap: DecisionReportGap) {
    const target = document.getElementById(gap.targetId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
  }

  function answerGap(gap: DecisionReportGap, answer: string): boolean {
    const command = createGapAnswerCommand(
      gap,
      answer,
      gap.kind === "action" ? `user-action-${crypto.randomUUID()}` : undefined,
    );
    if (!command.ok) {
      setEditError(command.error);
      return false;
    }
    return dispatchEdit(command.command);
  }

  function setDataClassification(
    value: DecisionReportV1["implementation"]["governance"]["dataClassification"],
  ) {
    dispatchEdit({
      type: "set_data_classification",
      value,
    });
  }

  function saveReport() {
    setSaveError(null);
    startSaving(async () => {
      try {
        const result: SaveDecisionReportActionResult = await saveDecisionReportAction({
          reportId: persistence?.reportId ?? null,
          baseRevisionId: persistence?.revisionId ?? null,
          report,
          metricProjection: projection,
        });
        if (!result.ok) {
          setSaveError(result.error);
          return;
        }

        setPersistence({
          reportId: result.saved.reportId,
          revisionId: result.saved.revisionId,
          status: result.saved.status,
          savedAt: result.saved.savedAt,
          activation: null,
        });
        setSavedSnapshot(JSON.stringify(report));
        router.replace(`/onboarding?report=${result.saved.reportId}`, { scroll: false });
      } catch {
        setSaveError("Causent could not save this report. Your edits are still here—try again.");
      }
    });
  }

  function uploadAsset(file: File) {
    if (!persistence) {
      setAssetError("Save the report before uploading a supplied image.");
      return;
    }
    setAssetError(null);
    startChangingAsset(async () => {
      const formData = new FormData();
      formData.set("image", file);
      try {
        const result = await uploadDecisionReportImageAction({
          reportId: persistence.reportId,
          baseRevisionId: persistence.revisionId,
          report,
          metricProjection: projection,
        }, formData);
        if (!result.ok) return setAssetError(result.error);
        const nextReport = cloneDecisionReport(report);
        nextReport.implementation.assetIds = result.asset ? [result.asset.assetId] : [];
        setReport(nextReport);
        setAsset(result.asset);
        setPersistence({ ...persistence, revisionId: result.revisionId, status: result.status, savedAt: new Date().toISOString() });
        setSavedSnapshot(JSON.stringify(nextReport));
        router.replace(`/onboarding?report=${persistence.reportId}`, { scroll: false });
      } catch {
        setAssetError("Causent could not process that image. Your report was not changed—try again.");
      }
    });
  }

  function removeAsset() {
    if (!persistence || !asset) return;
    setAssetError(null);
    startChangingAsset(async () => {
      try {
        const result = await removeDecisionReportImageAction({
          reportId: persistence.reportId,
          baseRevisionId: persistence.revisionId,
          report,
          metricProjection: projection,
        }, asset.assetId);
        if (!result.ok) return setAssetError(result.error);
        const nextReport = cloneDecisionReport(report);
        nextReport.implementation.assetIds = [];
        setReport(nextReport);
        setAsset(null);
        setPersistence({ ...persistence, revisionId: result.revisionId, status: result.status, savedAt: new Date().toISOString() });
        setSavedSnapshot(JSON.stringify(nextReport));
      } catch {
        setAssetError("Causent could not remove that image. It remains private and attached—try again.");
      }
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
                {reportIsActive ? "Active" : persistence?.status === "report_ready" ? "Reviewed" : "Draft"}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-semibold ${
                  reportIsActive
                    ? "bg-teal-50 text-teal-800"
                    : ready
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-amber-50 text-amber-800"
                }`}
              >
                {reportIsActive ? "Activated" : ready ? "Ready for review" : `${gaps.length} required fields open`}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-semibold ${
                  hasUnsavedChanges
                    ? "bg-slate-100 text-slate-700"
                    : "bg-blue-50 text-blue-800"
                }`}
              >
                {hasUnsavedChanges ? "Unsaved" : "Saved"}
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
              disabled={reportIsActive}
              onChange={(event) => setReport((current) => ({ ...current, title: event.target.value }))}
            />
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[var(--text-muted)]">
              {reportIsActive
                ? "This reviewed revision is locked to the activated decision, prediction, and action plan."
                : "One brief produced a decision, evidence map, metric hypothesis, and action plan. Every field remains yours to edit."}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            onClick={onStartOver}
          >
            {reportIsActive ? "New report" : "Edit"}
          </button>
        </div>
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            How to read this draft
          </p>
          <ProvenanceLegend />
        </div>
      </header>

      <DecisionSection decision={report.decision} readOnly={reportIsActive} onClaimChange={updateClaim} />
      <SupportingEvidenceSection
        evidence={report.supportingEvidence}
        projection={projection}
        readOnly={reportIsActive}
        onClaimChange={updateClaim}
      />
      <ImplementationSection
        implementation={report.implementation}
        readOnly={reportIsActive}
        onClaimChange={updateClaim}
        onActionTitleChange={updateActionTitle}
        onActionSummaryChange={updateActionSummary}
        onActionOwnerChange={updateActionOwner}
        onDataClassificationChange={setDataClassification}
        asset={asset}
        assetPending={isChangingAsset}
        assetDisabled={!persistence}
        assetError={assetError}
        onAssetUpload={uploadAsset}
        onAssetRemove={removeAsset}
      />

      {!reportIsActive ? (
        <ReportCompletionPanel
          gaps={gaps}
          onAnswer={answerGap}
          onFocus={focusGap}
        />
      ) : null}

      {ready ? (
        <ReportActivationPanel
          report={report}
          projection={projection}
          persistence={persistence}
          hasUnsavedChanges={hasUnsavedChanges}
          metrics={activationMetrics}
        />
      ) : null}

      {editError ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800"
          role="alert"
        >
          {editError}
        </p>
      ) : null}

      {saveError ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800"
          role="alert"
        >
          {saveError}
        </p>
      ) : null}

      {!reportIsActive ? <div
        className={`sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-lg shadow-slate-300/30 backdrop-blur ${
          ready
            ? "border-emerald-200 bg-emerald-50/95"
            : "border-[var(--border)] bg-white/95"
        }`}
        aria-live="polite"
      >
        <div>
          <p className={`text-[12px] font-semibold ${ready ? "text-emerald-900" : "text-[var(--text)]"}`}>
            {ready ? "Ready for review" : "Decision Report not ready"}
          </p>
          <p className={`text-[11px] ${ready ? "text-emerald-900/75" : "text-[var(--text-muted)]"}`}>
            {ready
              ? hasUnsavedChanges
                ? "All six required fields are complete. Save this report to keep the reviewed revision."
                : "All six required fields are complete. This reviewed revision is saved."
              : `${gaps.length} required ${gaps.length === 1 ? "field remains" : "fields remain"}. ${hasUnsavedChanges ? "Save this draft to keep your latest changes." : "This draft is saved."}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!ready ? (
            <button
              type="button"
              className="rounded-lg bg-[var(--text)] px-4 py-2 text-[12px] font-semibold text-white"
              aria-controls={gaps[0].targetId}
              onClick={() => focusGap(gaps[0])}
            >
              Go to next required field
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-lg bg-[var(--text)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
            disabled={isSaving || !hasUnsavedChanges}
            onClick={saveReport}
          >
            {isSaving
              ? "Saving…"
              : !hasUnsavedChanges
                ? "Saved"
                : persistence
                  ? "Save changes"
                  : ready
                    ? "Save report"
                    : "Save draft"}
          </button>
        </div>
      </div> : null}
    </div>
  );
}
