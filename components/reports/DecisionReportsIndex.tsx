"use client";

import { useState } from "react";
import Link from "next/link";
import type { DashboardDecisionReport } from "@/lib/data/decision-reports";
import { Panel } from "@/components/ui/Panel";
import { ReportIcon } from "@/components/ui/icons";

function claimText(claims: Array<{ text: string; status: string }>): string {
  return claims.find((claim) => claim.status !== "missing" && claim.text.trim())?.text ?? "Not supplied";
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
              <Link href={`/onboarding?report=${selected.id}`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] font-semibold text-[var(--brand-blue)]">
                Open full report
              </Link>
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
        ) : null}
      </Panel>
    </div>
  );
}
