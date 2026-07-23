import Link from "next/link";
import type { Action, Metric } from "@/lib/types";
import { formatShortDate } from "@/lib/format";
import { Delta } from "@/components/ui/Delta";
import {
  ActionSourceIcon,
  actionReferenceLabel,
} from "@/components/actions/ActionReference";

// One row per action (always — clustering is an overlay, never hides a row). Each
// metric cell renders authoritative ITS impact when confident, or the explicitly
// labeled preliminary 14-day descriptive cross-check while ITS gathers history.

export function ActionsTable({
  actions,
  metrics,
}: {
  actions: Action[];
  metrics: Metric[];
}) {
  const nameById = new Map(metrics.map((m) => [m.id, m.name]));
  const columns = metrics.map((metric) => metric.id);
  return (
    <div className="scroll-slim overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
            <th className="py-2 pr-3 font-medium">Action</th>
            <th className="px-2 py-2 font-medium">Shipped</th>
            {columns.map((id) => (
              <th key={id} className="px-2 py-2 text-right font-medium whitespace-nowrap">
                {nameById.get(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => {
            const byMetric = new Map(a.impact.map((c) => [c.metricId, c]));
            return (
              <tr
                key={a.id}
                className="border-b border-[var(--border)] last:border-0 hover:bg-black/[0.015]"
              >
                <td className="py-2.5 pr-3">
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <ActionSourceIcon
                      action={a}
                      size={16}
                      className="shrink-0 text-[var(--text-subtle)]"
                    />
                    <Link
                      href={`/actions?selected=${a.id}`}
                      className="max-w-[190px] truncate font-medium text-[var(--brand-blue)] hover:underline"
                    >
                      {a.title}
                    </Link>
                    <span className="text-[var(--text-subtle)] tabular-nums">
                      {actionReferenceLabel(a)}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2.5 whitespace-nowrap text-[var(--text-muted)]">
                  {a.shippedAt ? formatShortDate(a.shippedAt) : "—"}
                </td>
                {columns.map((id) => {
                  const c = byMetric.get(id);
                  return (
                    <td key={id} className="px-2 py-2.5 text-right">
                      {c && c.value !== null ? (
                        <div className="inline-flex flex-col items-end" title={c.detail}>
                          <Delta
                            direction={c.direction}
                            label={c.label}
                            good={c.good}
                            size="sm"
                            tone={c.evidence === "descriptive" ? "neutral" : "auto"}
                          />
                          {c.evidence === "descriptive" ? (
                            <span className="mt-0.5 text-[10px] font-medium text-[var(--text-subtle)]">
                              14-day descriptive{c.detail?.includes("Overlaps") ? " · overlapping actions" : ""}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-[var(--text-subtle)]">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
