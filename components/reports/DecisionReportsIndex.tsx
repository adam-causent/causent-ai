"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import type { DashboardDecisionReport } from "@/lib/data/decision-reports";
import { Panel } from "@/components/ui/Panel";
import { ReportIcon, TrashIcon } from "@/components/ui/icons";
import {
  deleteDecisionReportAction,
  type DeleteReportActionState,
} from "@/app/(dashboard)/reports/server-actions";

function claimText(claims: Array<{ text: string; status: string }>): string {
  return claims.find((claim) => claim.status !== "missing" && claim.text.trim())?.text ?? "Not supplied";
}

const DELETE_INITIAL_STATE: DeleteReportActionState = { status: "idle" };

function DeleteReportControl({
  reportId,
  active,
}: {
  reportId: string;
  active: boolean;
}) {
  const [state, action, pending] = useActionState(
    deleteDecisionReportAction,
    DELETE_INITIAL_STATE,
  );
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-[12px] font-semibold text-red-700 hover:bg-red-50 marker:hidden">
        <TrashIcon /> Delete report
      </summary>
      <form action={action} className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-red-200 bg-white p-3 shadow-xl">
        <input type="hidden" name="reportId" value={reportId} />
        <p className="text-[12px] font-semibold text-[var(--text)]">Remove this report?</p>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
          It disappears from workspace history. {active
            ? "Its completed decision and actions remain in the audit record."
            : "Its revisions and supplied files remain in the audit record."}
        </p>
        {state.status === "error" ? (
          <p className="mt-2 text-[11px] text-red-700" role="alert">{state.error}</p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="mt-3 w-full rounded-lg bg-red-700 px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Removing…" : "Yes, remove report"}
        </button>
      </form>
    </details>
  );
}

export function DecisionReportsIndex({ reports }: { reports: DashboardDecisionReport[] }) {
  const [selectedId, setSelectedId] = useState(reports[0]?.id ?? "");
  const selected = reports.find((report) => report.id === selectedId) ?? reports[0];

  return (
    <div className="mx-auto grid h-full max-w-[1360px] grid-cols-1 gap-4 p-5 lg:grid-cols-[340px_1fr]">
      <Panel className="flex min-h-0 flex-col">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">Decision Reports</h2>
          <Link href="/onboarding" className="rounded-lg bg-[var(--brand-blue)] px-2.5 py-2 text-[12px] font-semibold text-white">
            New Report
          </Link>
        </div>
        <div className="scroll-slim -mx-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1">
          {reports.map((report) => (
            <button
              key={report.id}
              type="button"
              onClick={() => setSelectedId(report.id)}
              className={`w-full rounded-lg border px-3 py-2.5 text-left ${report.id === selected?.id ? "border-[var(--brand-blue)] bg-[var(--brand-blue)]/[0.05]" : "border-[var(--border)] hover:bg-black/[0.02]"}`}
            >
              <div className="flex items-center gap-2">
                <ReportIcon className="shrink-0 text-[var(--text-subtle)]" />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{report.title}</span>
                <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-subtle)]">{report.status.replace("_", " ")}</span>
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">Updated {report.updatedAt.slice(0, 10)}</p>
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="min-h-0 overflow-y-auto">
        {selected ? (
          <article className="space-y-5">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] pb-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Decision Report</p>
                <h1 className="mt-1 text-[24px] font-semibold tracking-tight">{selected.title}</h1>
                <p className="mt-1 text-[12px] text-[var(--text-muted)]">Core metric: {selected.metricProjection.metricName}</p>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <Link href={`/onboarding?report=${selected.id}`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] font-semibold text-[var(--brand-blue)]">
                  Open full report
                </Link>
                <DeleteReportControl
                  reportId={selected.id}
                  active={selected.status === "active"}
                />
              </div>
            </header>
            <section>
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Decision</h2>
              <p className="mt-2 text-[14px] leading-6">{claimText(selected.report.decision.decision)}</p>
              <p className="mt-2 text-[13px] leading-6 text-[var(--text-muted)]">{claimText(selected.report.decision.problem)}</p>
            </section>
            <section>
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Supporting evidence</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-6 text-[var(--text-muted)]">
                {selected.report.supportingEvidence.factors.filter((claim) => claim.status !== "missing").map((claim) => <li key={claim.id}>{claim.text}</li>)}
              </ul>
            </section>
            <section>
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Implementation</h2>
              <p className="mt-2 text-[13px] leading-6 text-[var(--text-muted)]">{claimText(selected.report.implementation.actionPlanSummary)}</p>
              <ol className="mt-3 space-y-2">
                {selected.report.implementation.actions.map((action) => <li key={action.sourceItemId} className="rounded-lg border border-[var(--border)] px-3 py-2 text-[13px] font-medium">{action.title}</li>)}
              </ol>
            </section>
          </article>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <ReportIcon className="text-[var(--text-subtle)]" />
            <p className="text-[14px] text-[var(--text-muted)]">No Decision Reports in this workspace.</p>
            <Link href="/onboarding" className="rounded-lg bg-[var(--brand-blue)] px-3 py-2 text-[12px] font-semibold text-white">
              Create Decision Report
            </Link>
          </div>
        )}
      </Panel>
    </div>
  );
}
