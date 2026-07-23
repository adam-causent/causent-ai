"use client";

import { useActionState } from "react";
import { FileCsvIcon } from "@/components/ui/icons";
import {
  importWorkspaceMetricCsvAction,
  type WorkspaceMetricCsvImportActionState,
} from "@/app/(dashboard)/data-workshop/server-actions";

const INITIAL_STATE: WorkspaceMetricCsvImportActionState = { status: "idle" };

/** Import or update a named workspace metric for Decision Report selection. */
export function WorkspaceMetricCsvDropzone({
  activeMetricName,
}: {
  activeMetricName?: string | null;
}) {
  const [state, action, pending] = useActionState(importWorkspaceMetricCsvAction, INITIAL_STATE);

  return (
    <section aria-labelledby="workspace-metric-import-title">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)]">
          <FileCsvIcon />
        </div>
        <div>
          <h2 id="workspace-metric-import-title" className="text-[15px] font-semibold text-[var(--text)]">
            Add a core metric
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[var(--text-muted)]">
            Name the metric, choose its unit, and import one daily <span className="font-mono">date,value</span> CSV. Then add it to the shared Core Metrics surface from the list below.
            {activeMetricName ? ` To update the current report metric, use its exact name: ${activeMetricName}.` : ""}
          </p>
        </div>
      </div>

      <form action={action} className="mt-4 grid gap-3 md:grid-cols-[1.4fr_0.7fr_1.2fr_auto] md:items-end">
        <label className="text-[11px] font-medium text-[var(--text-muted)]" htmlFor="workspace-metric-name">
          Metric name
          <input
            id="workspace-metric-name"
            name="metricName"
            required
            maxLength={120}
            defaultValue={activeMetricName ?? undefined}
            placeholder="e.g. AI assistant adoption rate"
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[12px] text-[var(--text)] outline-none focus:border-[var(--brand-blue)]"
          />
        </label>
        <label className="text-[11px] font-medium text-[var(--text-muted)]" htmlFor="workspace-metric-unit">
          Unit
          <select
            id="workspace-metric-unit"
            name="unit"
            defaultValue="count"
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[12px] text-[var(--text)] outline-none focus:border-[var(--brand-blue)]"
          >
            <option value="percent">Percent</option>
            <option value="count">Count</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="text-[11px] font-medium text-[var(--text-muted)]" htmlFor="workspace-metric-csv">
          CSV file
          <input
            id="workspace-metric-csv"
            name="csv"
            required
            type="file"
            accept=".csv,text/csv"
            disabled={pending}
            className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-white px-2 py-[6px] text-[11px] text-[var(--text-muted)] file:mr-2 file:rounded-md file:border-0 file:bg-[var(--brand-blue)] file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[var(--brand-blue)] px-4 py-2 text-[12px] font-semibold text-white hover:brightness-105 disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import metric"}
        </button>
      </form>

      {state.status === "error" ? (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-left text-[12px] text-red-900">
          <p className="font-semibold">{state.error}</p>
          {(state.acceptedRows > 0 || state.rejectedRows > 0) ? (
            <p className="mt-1">Parsed {state.acceptedRows} valid · rejected {state.rejectedRows} · wrote 0</p>
          ) : null}
          {state.details.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-4">{state.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
          ) : null}
        </div>
      ) : null}
      {state.status === "success" ? (
        <div role="status" className="mt-4 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-left text-[12px] text-teal-950">
          <p className="font-semibold">
            {state.summary.created ? "Created" : "Updated"} {state.summary.metricName} and imported {state.summary.acceptedRows.toLocaleString("en-US")} rows.
          </p>
          <p className="mt-1">
            {state.summary.startDate} to {state.summary.endDate} · {state.summary.insertedRows} new · {state.summary.updatedRows} updated
          </p>
          <p className="mt-1 text-teal-900/75">
            This metric is now available in the workspace catalog. Add it to Core Metrics below to show it across the dashboard.
          </p>
        </div>
      ) : null}
    </section>
  );
}
