import Link from "next/link";
import type { Action, Metric } from "@/lib/types";
import { formatShortDate } from "@/lib/format";
import { Delta } from "@/components/ui/Delta";
import { GitHubIcon } from "@/components/ui/icons";

// One row per action (always — clustering is an overlay, never hides a row). Each
// metric cell renders the authoritative (ITS) impact with a colorblind-safe cue.

const COLUMNS = ["arr", "grossProfit", "activation", "churn", "support"] as const;

export function ActionsTable({
  actions,
  metrics,
}: {
  actions: Action[];
  metrics: Metric[];
}) {
  const nameById = new Map(metrics.map((m) => [m.id, m.name]));
  return (
    <div className="scroll-slim overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
            <th className="py-2 pr-3 font-medium">Action (Merged PR)</th>
            <th className="px-2 py-2 font-medium">Shipped</th>
            {COLUMNS.map((id) => (
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
                    <GitHubIcon size={16} className="shrink-0 text-[var(--text-subtle)]" />
                    <Link
                      href={`/actions?selected=${a.id}`}
                      className="max-w-[190px] truncate font-medium text-[var(--brand-blue)] hover:underline"
                    >
                      {a.title}
                    </Link>
                    <span className="text-[var(--text-subtle)] tabular-nums">
                      #{a.pr}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2.5 whitespace-nowrap text-[var(--text-muted)]">
                  {a.shippedAt ? formatShortDate(a.shippedAt) : "—"}
                </td>
                {COLUMNS.map((id) => {
                  const c = byMetric.get(id);
                  return (
                    <td key={id} className="px-2 py-2.5 text-right">
                      {c && c.direction !== "neutral" ? (
                        <span className="inline-flex justify-end">
                          <Delta
                            direction={c.direction}
                            label={c.label}
                            good={c.good}
                            size="sm"
                          />
                        </span>
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
