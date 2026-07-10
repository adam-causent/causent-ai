"use client";

import { useState } from "react";
import type {
  Action,
  ImpactStat,
  Metric,
  MetricImpact,
  ProjectObjective,
  Report,
  Scope,
} from "@/lib/types";
import { Panel } from "@/components/ui/Panel";
import { PlusIcon, ReportIcon } from "@/components/ui/icons";
import { ReportPreview } from "@/components/reports/ReportPreview";

// Client half of the Reports tab: a saved-report list on the left (click to
// select, plus "New Report") and the rendered report document on the right. Data
// is fetched on the server and passed in as plain props.
export function ReportsPageClient({
  reports,
  scope,
  objective,
  aggregatedImpact,
  impactByMetric,
  metrics,
  actions,
}: {
  reports: Report[];
  scope: Scope;
  objective: ProjectObjective | null;
  aggregatedImpact: ImpactStat[];
  impactByMetric: MetricImpact[];
  metrics: Metric[];
  actions: Action[];
}) {
  const [selectedId, setSelectedId] = useState(reports[0]?.id ?? "");
  const selected = reports.find((r) => r.id === selectedId) ?? reports[0];

  return (
    <div className="mx-auto grid h-full max-w-[1360px] grid-cols-1 gap-4 p-5 lg:grid-cols-[340px_1fr]">
      <Panel className="flex min-h-0 flex-col">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">Reports</h2>
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--brand-blue)] px-2.5 text-[12px] font-semibold text-white hover:brightness-105"
          >
            <PlusIcon />
            New Report
          </button>
        </div>

        <div className="scroll-slim -mx-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1">
          {reports.map((r) => {
            const active = r.id === selected?.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? "border-[var(--brand-blue)] bg-[var(--brand-blue)]/[0.05]"
                    : "border-[var(--border)] hover:bg-black/[0.02]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <ReportIcon className="shrink-0 text-[var(--text-subtle)]" />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--text)]">
                    {r.title}
                  </span>
                  <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                    {r.depth === "full" ? "Full" : "Succinct"}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--text-muted)]">
                  {r.summary}
                </div>
                <div className="mt-1.5 text-[11px] text-[var(--text-subtle)] tabular-nums">
                  {r.createdAt} · {r.author}
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel className="flex min-h-0 flex-col overflow-hidden">
        {selected ? (
          <ReportPreview
            report={selected}
            scope={scope}
            objective={objective}
            aggregatedImpact={aggregatedImpact}
            impactByMetric={impactByMetric}
            metrics={metrics}
            actions={actions}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <ReportIcon className="text-[var(--text-subtle)]" />
            <p className="text-[14px] text-[var(--text-muted)]">
              No reports yet. Create one to roll up this project for stakeholders.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}
