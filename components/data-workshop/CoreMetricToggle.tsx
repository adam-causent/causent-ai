"use client";

import { useActionState } from "react";
import {
  setWorkspaceCoreMetricAction,
  type CoreMetricSelectionActionState,
} from "@/app/(dashboard)/data-workshop/server-actions";
import { TrashIcon } from "@/components/ui/icons";

const INITIAL_STATE: CoreMetricSelectionActionState = { status: "idle" };

export function CoreMetricToggle({
  metricId,
  selected,
  metricName,
  appearance = "toggle",
}: {
  metricId: string;
  selected: boolean;
  metricName?: string;
  appearance?: "catalog" | "remove" | "toggle";
}) {
  const [state, action, pending] = useActionState(setWorkspaceCoreMetricAction, INITIAL_STATE);
  const isSelected = state.status === "success" ? state.isCore : selected;
  const nextValue = appearance === "remove" ? false : !isSelected;

  const button = appearance === "remove" ? (
    <button
      type="submit"
      disabled={pending}
      aria-label={`Remove ${metricName ?? "metric"} from Core Metrics`}
      title="Remove from Core Metrics"
      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-wait disabled:opacity-60"
    >
      <TrashIcon />
    </button>
  ) : appearance === "catalog" ? (
    <button
      type="submit"
      disabled={pending || isSelected}
      className="min-w-16 rounded-md bg-emerald-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-default disabled:bg-emerald-100 disabled:text-emerald-800"
    >
      {pending ? "Adding…" : isSelected ? "Added" : "Add"}
    </button>
  ) : (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md border px-2.5 py-1.5 font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${
        isSelected
          ? "border-teal-300 bg-teal-50 text-teal-800 hover:bg-teal-100"
          : "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
      }`}
    >
      {pending ? "Saving…" : isSelected ? "Remove" : "Add"}
    </button>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <input type="hidden" name="metricId" value={metricId} />
        <input type="hidden" name="isCore" value={nextValue ? "true" : "false"} />
        {button}
      </form>
      {state.status === "error" ? (
        <p className="max-w-48 text-right text-[10px] leading-4 text-red-700" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.status === "success" && appearance === "toggle" ? (
        <p className="text-[10px] text-teal-700" role="status">
          {state.isCore ? "Added" : "Removed"} · {state.coreMetricCount}/5 selected
        </p>
      ) : null}
    </div>
  );
}
