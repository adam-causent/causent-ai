import { CoreMetricToggle } from "@/components/data-workshop/CoreMetricToggle";
import type { ReportActivationMetric } from "@/lib/decision-reports/materialization";

function originLabel(source: string): string {
  if (source === "csv") return "CSV";
  if (source === "bigquery") return "BQ";
  if (source === "postgres") return "Postgres";
  if (source === "connector") return "Connected";
  return source.replaceAll("_", " ").toUpperCase();
}

export function WorkspaceMetricCatalog({
  metrics,
  activeMetricId,
}: {
  metrics: ReportActivationMetric[];
  activeMetricId?: string | null;
}) {
  return (
    <div>
      <h3 className="mb-3 text-[13px] font-semibold text-[var(--text)]">
        Workspace Metrics
      </h3>
      {metrics.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-3 text-[12px] text-[var(--text-muted)]">
          No workspace metrics yet. Import one above to make it selectable.
        </p>
      ) : (
        <table className="w-full border-collapse overflow-hidden rounded-lg border border-[var(--border)] text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
              <th className="px-4 py-2 font-medium">Metric Name</th>
              <th className="px-4 py-2 font-medium">Origin</th>
              <th className="px-4 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.metricId} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3">
                  <span className="font-medium text-[var(--text)]">{metric.name}</span>
                  {activeMetricId === metric.metricId ? (
                    <span className="ml-2 rounded-full bg-teal-50 px-2 py-1 text-[10px] font-semibold text-teal-800">
                      Report metric
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-semibold text-[var(--text-muted)]">
                    {originLabel(metric.source)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-[11px]">
                  <CoreMetricToggle metricId={metric.metricId} selected={metric.isCore} appearance="catalog" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
