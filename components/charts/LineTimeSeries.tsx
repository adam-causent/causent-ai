import type { MetricFormat, Observation } from "@/lib/types";
import Link from "next/link";
import { formatMetricValue, formatMonthTick, formatShortDate } from "@/lib/format";
import {
  indexOfDate,
  linePoints,
  paddedExtent,
  tickIndices,
  yFrac,
} from "@/components/charts/geometry";

export type SeriesFlag = {
  date: string;
  label: string;
  color?: string;
  href?: string;
  title?: string;
};

const PLOT_H = 100; // viewBox units; SVG scales to container via non-scaling stroke

/**
 * Daily time-series line with y/x axis labels and optional named action flags
 * (PR pills) dropped onto the timeline. Pure/SSR-safe — no client hooks.
 */
export function LineTimeSeries({
  series,
  color,
  format,
  height = 120,
  flags = [],
  yTicks = 3,
  xTicks = 6,
}: {
  series: Observation[];
  color: string;
  format: MetricFormat;
  height?: number;
  flags?: SeriesFlag[];
  yTicks?: number;
  xTicks?: number;
}) {
  const values = series.map((o) => o.value);
  const extent = paddedExtent(values, 0.14);
  const points = linePoints(series, extent, 1000, PLOT_H);
  const n = series.length;

  const spanDays = n; // one point per day
  const xLabel = (o: Observation) =>
    spanDays > 70 ? formatMonthTick(o.date) : formatShortDate(o.date);

  const yTickValues = Array.from({ length: yTicks }, (_, i) => {
    const t = i / (yTicks - 1);
    return extent.max - t * (extent.max - extent.min);
  });

  const xIdx = tickIndices(n, xTicks);

  const flagPositions = flags.map((f) => {
    const idx = indexOfDate(series, f.date);
    return { ...f, left: n <= 1 ? 0 : (idx / (n - 1)) * 100 };
  });

  return (
    <div className="relative w-full" style={{ height }}>
      {/* y-axis labels */}
      <div
        className="absolute left-0 top-[18px] bottom-[18px] w-[42px] flex flex-col justify-between text-right pr-1.5 text-[10px] text-[var(--text-subtle)] tabular-nums"
        aria-hidden="true"
      >
        {yTickValues.map((v, i) => (
          <span key={i}>{formatMetricValue(v, format)}</span>
        ))}
      </div>

      {/* plot area */}
      <div className="absolute left-[46px] right-1 top-[18px] bottom-[18px]">
        <svg
          className="absolute inset-0"
          width="100%"
          height="100%"
          viewBox={`0 0 1000 ${PLOT_H}`}
          preserveAspectRatio="none"
          fill="none"
        >
          {/* horizontal gridlines */}
          {yTickValues.map((v, i) => {
            const y = yFrac(v, extent) * PLOT_H;
            return (
              <line
                key={i}
                x1="0"
                x2="1000"
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {/* flag drop-lines */}
          {flagPositions.map((f, i) => (
            <line
              key={i}
              x1={(f.left / 100) * 1000}
              x2={(f.left / 100) * 1000}
              y1="0"
              y2={PLOT_H}
              stroke={f.color ?? color}
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* the series */}
          <polyline
            points={points}
            stroke={color}
            strokeWidth="1.9"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* flag pills */}
        {flagPositions.map((f, i) => {
          const className = "absolute -top-[15px] -translate-x-1/2 whitespace-nowrap rounded-full border bg-[var(--surface)] px-1.5 py-[1px] text-[10px] font-medium leading-none tabular-nums shadow-sm";
          const style = {
            left: `${f.left}%`,
            borderColor: f.color ?? color,
            color: f.color ?? color,
          };
          return f.href ? (
            <Link
              key={i}
              href={f.href}
              title={f.title}
              aria-label={f.title ? `${f.label}: ${f.title}` : f.label}
              className={`${className} z-10 hover:bg-[var(--bg)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2`}
              style={style}
            >
              {f.label}
            </Link>
          ) : (
            <span key={i} className={className} style={style} title={f.title}>
              {f.label}
            </span>
          );
        })}
      </div>

      {/* x-axis labels */}
      <div className="absolute left-[46px] right-1 bottom-0 h-[16px]">
        {xIdx.map((idx, i) => {
          const left = n <= 1 ? 0 : (idx / (n - 1)) * 100;
          return (
            <span
              key={i}
              className="absolute -translate-x-1/2 text-[10px] text-[var(--text-subtle)]"
              style={{ left: `${Math.min(97, Math.max(3, left))}%` }}
            >
              {xLabel(series[idx])}
            </span>
          );
        })}
      </div>
    </div>
  );
}
