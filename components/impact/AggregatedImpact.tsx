import type { ImpactStat, Metric, MetricImpact } from "@/lib/types";
import { Panel } from "@/components/ui/Panel";

const TONE = {
  positive: "text-[var(--pos)]",
  negative: "text-[var(--neg)]",
  neutral: "text-[var(--text-muted)]",
  plain: "text-[var(--text)]",
} as const;

// The Aggregated-Impact strip. Leads with the two framing numbers — how many
// metrics we track and how often shipping improves them — then breaks the total
// business impact into its top four contributing metrics (by magnitude of
// confident causal lift). Metrics with no confident readout ("—") are skipped:
// we never pad the strip with a fabricated zero.
export function AggregatedImpact({
  stats,
  impactByMetric,
  metrics,
}: {
  stats: ImpactStat[];
  impactByMetric: MetricImpact[];
  metrics: Metric[];
}) {
  const metricById = new Map(metrics.map((m) => [m.id, m]));

  // "Improvement rate" = share of shipped actions with a confident good outcome.
  const improvement =
    stats.find((s) => /win rate|improvement/i.test(s.label)) ?? null;

  // Top 4 metrics by magnitude of confident business impact.
  const top = [...impactByMetric]
    .filter((r) => r.direction !== "neutral")
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 4);

  return (
    <Panel>
      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold text-[var(--text)]">
          Aggregated Impact
        </h2>
        <span className="text-[12px] text-[var(--text-muted)]">
          Net confident causal lift across tracked metrics
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Metrics Tracked"
          value={String(metrics.length)}
          sub="in this workspace"
          valueClass={TONE.plain}
        />
        <StatTile
          label="Improvement Rate"
          value={improvement?.value ?? "—"}
          sub={improvement?.comparison ?? ""}
          change={improvement?.change}
          valueClass={TONE.positive}
        />

        {top.map((r) => {
          const m = metricById.get(r.metricId);
          return (
            <div
              key={r.metricId}
              className="rounded-lg border border-[var(--border)] px-3 py-3"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: m?.color }}
                  aria-hidden="true"
                />
                <span className="truncate">{m?.name ?? r.metricId}</span>
              </div>
              <div
                className={`mt-1.5 text-[26px] font-bold leading-none tabular-nums ${
                  r.good ? TONE.positive : TONE.negative
                }`}
              >
                {r.label}
              </div>
              <div className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
                {r.good ? "net positive" : "net negative"}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function StatTile({
  label,
  value,
  sub,
  change,
  valueClass,
}: {
  label: string;
  value: string;
  sub: string;
  change?: string;
  valueClass: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] px-3 py-3">
      <div className="text-[11px] font-medium text-[var(--text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1.5 text-[26px] font-bold leading-none tabular-nums ${valueClass}`}
      >
        {value}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-subtle)] tabular-nums">
        <span>{sub}</span>
        {change && (
          <span className="font-semibold text-[var(--pos)]">{change}</span>
        )}
      </div>
    </div>
  );
}
