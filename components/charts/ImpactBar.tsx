import type { Metric, MetricImpact } from "@/lib/types";
import { formatCurrencyDelta } from "@/lib/format";

// Horizontal diverging bar chart: each metric's net impact, positive to the
// right (teal) and negative to the left (red). Direction is reinforced by the
// signed value label at each bar tip, so it never reads by color alone.

/**
 * Round-number axis ticks anchored at 0: the raw step is snapped up to a
 * 1/2/5×10ⁿ "nice" value, then ticks are laid at every multiple of it inside
 * [min, max] — so labels read +$50K/+$100K instead of +$37.3K, and one tick
 * always aligns with the zero baseline.
 */
function niceTicks(min: number, max: number, count = 7): number[] {
  const span = max - min;
  if (span <= 0) return [0];
  const rawStep = span / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? rawStep;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return ticks;
}

export function ImpactBar({
  rows,
  metrics,
}: {
  rows: MetricImpact[];
  metrics: Metric[];
}) {
  const nameById = new Map(metrics.map((m) => [m.id, m.name]));
  const values = rows.map((r) => r.value);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const pad = (rawMax - rawMin) * 0.08 || 1;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const frac = (v: number) => ((v - min) / (max - min)) * 100;
  const zero = frac(0);
  const ticks = niceTicks(min, max);

  return (
    <div className="w-full">
      {/* legend */}
      <div className="mb-3 flex items-center justify-end gap-6 text-[11px] font-medium">
        <span className="text-[var(--neg)]">Negative Impact ←</span>
        <span className="text-[var(--pos)]">→ Positive Impact</span>
      </div>

      <div className="space-y-2.5">
        {rows.map((r) => {
          const metricName = nameById.get(r.metricId);
          const pos = r.value >= 0;
          const barColor = r.good ? "var(--pos)" : "var(--neg)";
          const left = Math.min(frac(r.value), zero);
          const width = Math.abs(frac(r.value) - zero);
          return (
            <div key={r.metricId} className="flex items-center">
              <div className="w-[112px] shrink-0 pr-3 text-right text-[13px] text-[var(--text)]">
                {metricName}
              </div>
              <div className="relative h-6 flex-1">
                {/* zero baseline */}
                <div
                  className="absolute top-0 bottom-0 w-px bg-[var(--border-strong)]"
                  style={{ left: `${zero}%` }}
                />
                {/* bar */}
                <div
                  className="absolute top-1/2 h-4 -translate-y-1/2 rounded-[3px]"
                  style={{ left: `${left}%`, width: `${width}%`, background: barColor }}
                />
                {/* value label at tip */}
                <span
                  className="absolute top-1/2 -translate-y-1/2 text-[12px] font-semibold tabular-nums"
                  style={{
                    left: pos ? `calc(${left + width}% + 6px)` : undefined,
                    right: pos ? undefined : `calc(${100 - left}% + 6px)`,
                    color: barColor,
                  }}
                >
                  {r.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* value axis */}
      <div className="mt-2 flex items-center">
        <div className="w-[112px] shrink-0" />
        <div className="relative h-4 flex-1">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute -translate-x-1/2 text-[10px] text-[var(--text-subtle)] tabular-nums"
              style={{ left: `${frac(t)}%` }}
            >
              {formatCurrencyDelta(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
