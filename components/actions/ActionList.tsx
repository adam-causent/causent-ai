import type { Action, Metric } from "@/lib/types";
import { formatLongDate } from "@/lib/format";
import { Sparkline } from "@/components/charts/Sparkline";
import { CheckIcon, GitHubIcon, PlusIcon } from "@/components/ui/icons";

export function ActionList({
  actions,
  metrics,
  selectedId,
  onSelect,
}: {
  actions: Action[];
  metrics: Metric[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  return (
    <div className="flex h-full flex-col">
      {/* actions */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <button className="flex items-center gap-2 rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-[13px] font-medium text-[var(--text)] hover:bg-black/[0.03]">
          <GitHubIcon size={16} />
          Connect GitHub
        </button>
        <button className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium text-[var(--text-muted)] hover:bg-black/[0.03]">
          <PlusIcon size={13} /> Add manual action
        </button>
      </div>

      <div className="scroll-slim min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {actions.map((a) => {
          const metric = metricById.get(a.primaryMetricId);
          const selected = a.id === selectedId;
          return (
            <button
              key={a.id}
              onClick={() => onSelect(a.id)}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                selected
                  ? "border-[var(--brand-blue)]/40 bg-[var(--brand-blue)]/[0.06]"
                  : "border-transparent hover:bg-black/[0.02]"
              }`}
            >
              <GitHubIcon size={20} className="shrink-0 text-[var(--text-subtle)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-[var(--text)]">
                  {a.title}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                  <span className="tabular-nums">#{a.pr}</span>
                  <CheckIcon size={12} className="text-[var(--pos)]" />
                  <span>
                    {a.shippedAt ? `Shipped ${formatLongDate(a.shippedAt)}` : "Not shipped"}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-[11px] text-[var(--text-muted)]">
                  {metric?.name}
                </span>
                {metric && (
                  <Sparkline
                    series={metric.series.slice(-56)}
                    color={metric.color}
                    width={70}
                    height={20}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
