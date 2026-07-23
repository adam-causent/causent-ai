import type { Metric } from "@/lib/types";
import { formatLongDate } from "@/lib/format";
import { summarizeMetricConnections } from "@/lib/data/metric-connections";
import { GripIcon } from "@/components/ui/icons";
import { CoreMetricToggle } from "@/components/data-workshop/CoreMetricToggle";

function updatedLabel(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${formatLongDate(iso.slice(0, 10))} ${time}`;
}

export function ConnectedMetrics({
  metrics,
  connectionSummary,
  removableMetricIdByName = {},
  lockedMetricName = null,
}: {
  metrics: Metric[];
  connectionSummary?: { connected: number; total: number };
  removableMetricIdByName?: Record<string, string>;
  lockedMetricName?: string | null;
}) {
  const summary = connectionSummary ?? summarizeMetricConnections(metrics.length);

  return (
    <div>
      <h3 className="mb-3 text-[13px] font-semibold text-[var(--text)]">
        Core Metrics ({summary.connected}/{summary.total})
      </h3>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
            <th className="py-2 pl-6 font-medium">Metric Name</th>
            <th className="px-2 py-2 font-medium">Source</th>
            <th className="px-2 py-2 font-medium">Last Updated</th>
            <th className="px-2 py-2 text-right font-medium">Rows</th>
            <th className="px-2 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <tr key={m.id} className="border-b border-[var(--border)] last:border-0">
              <td className="py-2.5">
                <div className="flex items-center gap-2">
                  <GripIcon className="text-[var(--text-subtle)]" />
                  <span
                    className="h-2.5 w-4 rounded-full"
                    style={{ background: m.color }}
                    aria-hidden="true"
                  />
                  <span className="font-medium text-[var(--text)]">{m.name}</span>
                </div>
              </td>
              <td className="px-2 py-2.5">
                <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">
                  {m.source}
                </span>
              </td>
              <td className="px-2 py-2.5 whitespace-nowrap text-[var(--text-muted)]">
                {updatedLabel(m.lastUpdated)}
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--text)]">
                {m.rows.toLocaleString("en-US")}
              </td>
              <td className="px-2 py-2.5">
                <div className="flex items-center justify-end gap-1">
                  {removableMetricIdByName[m.name] ? (
                    <CoreMetricToggle
                      metricId={removableMetricIdByName[m.name]}
                      metricName={m.name}
                      selected
                      appearance="remove"
                    />
                  ) : lockedMetricName === m.name ? (
                    <span className="text-[10px] font-medium text-[var(--text-subtle)]">Report metric</span>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* deferred connectors */}
      <div className="mt-3 flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-[13px] text-[var(--text-muted)]">
        <span>Connect a database or warehouse</span>
        <span className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
          Coming soon
        </span>
      </div>
    </div>
  );
}
