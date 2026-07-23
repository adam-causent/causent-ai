"use client";

import { useActionState } from "react";

import {
  completeManualActionAction,
  type ManualCompletionActionState,
} from "@/app/(dashboard)/actions/server-actions";

const INITIAL_STATE: ManualCompletionActionState = { status: "idle" };

export function ManualCompletionForm({ actionId }: { actionId: string }) {
  const [state, action, pending] = useActionState(completeManualActionAction, INITIAL_STATE);
  const today = new Date().toISOString().slice(0, 10);

  if (state.status === "success") {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900" role="status">
        Completed {state.completedOn}. {state.explanation}
      </div>
    );
  }

  return (
    <form action={action} className="rounded-lg border border-[var(--border)] bg-[var(--bg)]/60 p-3">
      <input type="hidden" name="actionId" value={actionId} />
      <p className="text-[11px] font-semibold text-[var(--text)]">Complete manually</p>
      <p className="mt-1 text-[10px] leading-4 text-[var(--text-muted)]">
        Use this when the work shipped outside GitHub or Jira. The date and explanation are retained on the action.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[170px_1fr_auto] sm:items-end">
        <label className="text-[10px] font-medium text-[var(--text-muted)]">
          Completion date
          <input
            required
            type="date"
            name="completedOn"
            defaultValue={today}
            max={today}
            className="mt-1 block w-full rounded-md border border-[var(--border)] bg-white px-2.5 py-2 text-[11px] text-[var(--text)]"
          />
        </label>
        <label className="text-[10px] font-medium text-[var(--text-muted)]">
          What was completed?
          <input
            required
            name="explanation"
            maxLength={1000}
            placeholder="Describe the shipped work and any relevant context."
            className="mt-1 block w-full rounded-md border border-[var(--border)] bg-white px-2.5 py-2 text-[11px] text-[var(--text)]"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-emerald-600 px-3 py-2 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Mark complete"}
        </button>
      </div>
      {state.status === "error" ? (
        <p className="mt-2 text-[10px] text-red-700" role="alert">{state.error}</p>
      ) : null}
    </form>
  );
}
