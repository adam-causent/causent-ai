"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { activateDecisionReportAction } from "@/app/(onboarding)/onboarding/decision-report-activation-actions";
import { CoreMetricToggle } from "@/components/data-workshop/CoreMetricToggle";
import type { ReportActivationMetric } from "@/lib/decision-reports/materialization";
import type {
  DecisionReportActivationPointer,
  DecisionReportPersistenceStatus,
} from "@/lib/decision-reports/persistence";
import type { DecisionReportV1, MetricProjection } from "@/lib/decision-reports/schema";

type ActivationPersistence = {
  reportId: string;
  revisionId: string;
  status: DecisionReportPersistenceStatus;
  activation: DecisionReportActivationPointer | null;
};

function DashboardCoreMetricSelector({ metrics }: { metrics: ReportActivationMetric[] }) {
  if (metrics.length === 0) return null;
  return (
    <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg)]/50 p-3" aria-labelledby="onboarding-core-metrics">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 id="onboarding-core-metrics" className="text-[12px] font-semibold text-[var(--text)]">
            Dashboard Core Metrics
          </h3>
          <p className="mt-0.5 text-[10px] leading-4 text-[var(--text-muted)]">
            Add up to five. These appear across dashboard tabs and in the bottom drawer.
          </p>
        </div>
        <span className="text-[10px] font-medium text-[var(--text-subtle)]">
          {metrics.filter((metric) => metric.isCore).length}/5 selected
        </span>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => (
          <li key={metric.metricId} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-white px-3 py-2">
            <span className="min-w-0 truncate text-[11px] font-medium text-[var(--text)]">{metric.name}</span>
            <CoreMetricToggle metricId={metric.metricId} selected={metric.isCore} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReportActivationPanel({
  report,
  projection,
  persistence,
  hasUnsavedChanges,
  metrics,
}: {
  report: DecisionReportV1;
  projection: MetricProjection;
  persistence: ActivationPersistence | null;
  hasUnsavedChanges: boolean;
  metrics: ReportActivationMetric[];
}) {
  const router = useRouter();
  const [metricId, setMetricId] = useState("");
  const [direction, setDirection] = useState<"POSITIVE" | "NEGATIVE">("POSITIVE");
  const [magnitude, setMagnitude] = useState("");
  const [resolutionDate, setResolutionDate] = useState("");
  const [selectedActions, setSelectedActions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (persistence?.status === "active" && persistence.activation) {
    return (
      <section
        className="rounded-2xl border border-teal-200 bg-teal-50/70 p-4 sm:p-5"
        aria-labelledby="activation-title"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-700">
          Decision activated
        </p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="activation-title" className="text-[17px] font-semibold text-teal-950">
              The reviewed report is now an action plan
            </h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-teal-900/80">
              Its decision, human prediction, and selected actions are locked to this report revision.
            </p>
          </div>
          <Link
            href={`/actions?selected=${persistence.activation.decisionId}`}
            className="rounded-lg bg-teal-900 px-4 py-2 text-[12px] font-semibold text-white"
          >
            Open Actions &amp; Decisions
          </Link>
        </div>
        <DashboardCoreMetricSelector metrics={metrics} />
      </section>
    );
  }

  const exactSavedRevision =
    persistence?.status === "report_ready" && !hasUnsavedChanges;
  const magnitudeNumber = Number(magnitude);
  const inputComplete =
    metricId !== "" &&
    Number.isFinite(magnitudeNumber) &&
    magnitudeNumber > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(resolutionDate) &&
    selectedActions.length >= 1 &&
    selectedActions.length <= 3;

  function toggleAction(sourceItemId: string) {
    setSelectedActions((current) =>
      current.includes(sourceItemId)
        ? current.filter((id) => id !== sourceItemId)
        : current.length < 3
          ? [...current, sourceItemId]
          : current,
    );
  }

  function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!persistence || !exactSavedRevision || !inputComplete) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await activateDecisionReportAction({
          schemaVersion: 1,
          reportId: persistence.reportId,
          revisionId: persistence.revisionId,
          confirmedMetricId: metricId,
          prediction: {
            direction,
            magnitudePctMean: magnitudeNumber,
            resolutionDate,
          },
          selectedActionSourceItemIds: selectedActions,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.push(`/actions?selected=${result.activation.decisionId}`);
      } catch {
        setError("Causent could not activate this report. No partial action plan was created—try again.");
      }
    });
  }

  return (
    <section
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm shadow-slate-200/40 sm:p-5"
      aria-labelledby="activation-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--brand-teal)]">
            Activate the plan
          </p>
          <h2 id="activation-title" className="mt-1 text-[17px] font-semibold text-[var(--text)]">
            Turn this report into tracked work
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[var(--text-muted)]">
            Confirm one real metric, make the team&apos;s prediction, and choose the actions to carry forward. Activation happens once and locks this reviewed revision.
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
          exactSavedRevision
            ? "bg-emerald-50 text-emerald-800"
            : "bg-amber-50 text-amber-800"
        }`}>
          {exactSavedRevision ? "Reviewed revision saved" : "Save the completed report first"}
        </span>
      </div>

      <DashboardCoreMetricSelector metrics={metrics} />

      <form className="mt-4 grid gap-3 xl:grid-cols-3" onSubmit={activate}>
        <fieldset className="rounded-xl border border-[var(--border)] p-3" disabled={!exactSavedRevision || isPending}>
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-subtle)]">
            1 · Confirm the prediction metric
          </legend>
          <p className="mt-1 text-[12px] font-medium text-[var(--text)]">
            Report hypothesis: {projection.metricName}
          </p>
          {metrics.length > 0 ? (
            <>
              <label className="mt-3 block text-[11px] font-medium text-[var(--text-muted)]" htmlFor="activation-metric">
                Workspace metric
              </label>
              <select
                id="activation-metric"
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[12px] text-[var(--text)]"
                value={metricId}
                onChange={(event) => setMetricId(event.target.value)}
              >
                <option value="">Choose a metric…</option>
                {metrics.map((metric) => (
                  <option key={metric.metricId} value={metric.metricId}>
                    {metric.name} · {metric.hasObservations ? "data connected" : "no observations"}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[10px] leading-4 text-[var(--text-subtle)]">
                The report&apos;s illustrative 40% and 55% values are not imported as observations.
              </p>
              <p className="mt-2 text-[10px] leading-4 text-[var(--text-subtle)]">
                This single metric owns the report prediction. Dashboard Core Metrics above are a separate multi-select.
              </p>
            </>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-3">
              <p className="text-[11px] leading-5 text-amber-900">
                No workspace metric is available yet.
              </p>
            </div>
          )}
          <Link
            href={`/data-workshop${persistence ? `?returnTo=${encodeURIComponent(`/onboarding?report=${persistence.reportId}`)}` : ""}`}
            className="mt-3 inline-flex text-[11px] font-semibold text-[var(--brand-blue)] underline-offset-2 hover:underline"
          >
            {metrics.length === 0 ? "Import a metric in Data Workshop →" : "Manage metrics in Data Workshop →"}
          </Link>
        </fieldset>

        <fieldset className="rounded-xl border border-[var(--border)] p-3" disabled={!exactSavedRevision || isPending}>
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-subtle)]">
            2 · Make a prediction
          </legend>
          <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">
            These values must come from you. The AI&apos;s chart is context, not a commitment.
          </p>
          <label className="mt-3 block text-[11px] font-medium text-[var(--text-muted)]" htmlFor="activation-direction">
            Expected direction
          </label>
          <select
            id="activation-direction"
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[12px]"
            value={direction}
            onChange={(event) => setDirection(event.target.value as "POSITIVE" | "NEGATIVE")}
          >
            <option value="POSITIVE">Increase</option>
            <option value="NEGATIVE">Decrease</option>
          </select>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[11px] font-medium text-[var(--text-muted)]" htmlFor="activation-magnitude">
              Magnitude (% of mean)
              <input
                id="activation-magnitude"
                className="mt-1 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] tabular-nums"
                inputMode="decimal"
                min="0"
                step="0.1"
                type="number"
                value={magnitude}
                onChange={(event) => setMagnitude(event.target.value)}
                placeholder="e.g. 15"
              />
            </label>
            <label className="text-[11px] font-medium text-[var(--text-muted)]" htmlFor="activation-date">
              Resolution date
              <input
                id="activation-date"
                className="mt-1 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[12px]"
                type="date"
                value={resolutionDate}
                onChange={(event) => setResolutionDate(event.target.value)}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-[var(--border)] p-3" disabled={!exactSavedRevision || isPending}>
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-subtle)]">
            3 · Choose actions
          </legend>
          <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">
            Select one to three generated actions. You can flesh them out in Actions &amp; Decisions.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {report.implementation.actions.map((action) => {
              const checked = selectedActions.includes(action.sourceItemId);
              return (
                <label
                  key={action.sourceItemId}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-4 ${
                    checked ? "border-teal-300 bg-teal-50/60" : "border-[var(--border)]"
                  }`}
                >
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && selectedActions.length >= 3}
                    onChange={() => toggleAction(action.sourceItemId)}
                  />
                  <span>
                    <span className="block font-semibold text-[var(--text)]">{action.title}</span>
                    <span className="text-[var(--text-muted)]">{action.summary[0]?.text}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] tabular-nums text-[var(--text-subtle)]">
            {selectedActions.length} of {Math.min(3, report.implementation.actions.length)} selected
          </p>
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 xl:col-span-3">
          <div>
            <p className="text-[11px] font-semibold text-[var(--text)]">
              One explicit materialization
            </p>
            <p className="text-[10px] leading-4 text-[var(--text-muted)]">
              Creates one decision, one prediction, and {selectedActions.length || "your selected"} planned {selectedActions.length === 1 ? "action" : "actions"}. It does not claim impact or create tracker tickets.
            </p>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-[var(--text)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!exactSavedRevision || !inputComplete || isPending}
          >
            {isPending ? "Activating…" : "Activate decision"}
          </button>
        </div>
      </form>

      {error ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
