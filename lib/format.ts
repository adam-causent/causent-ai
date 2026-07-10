import type { MetricFormat } from "@/lib/types";

/** Trim trailing zero decimals: "50.0" → "50", "2.40" → "2.4" (leaves "2.42"). */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Compact currency, e.g. 2_420_000 → "$2.42M", 8700 → "$8.7K", 50_000 → "$50K". */
export function formatCurrencyCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${trimZeros((abs / 1_000_000).toFixed(2))}M`;
  if (abs >= 1_000) return `${sign}$${trimZeros((abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1))}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Signed compact currency for deltas, e.g. 212000 → "+$212K". */
export function formatCurrencyDelta(value: number): string {
  if (value === 0) return "$0";
  const sign = value > 0 ? "+" : "-";
  return `${sign}${formatCurrencyCompact(Math.abs(value))}`;
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** Signed percentage-point delta, e.g. 6.3 → "+6.3pp". */
export function formatPpDelta(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(1)}pp`;
}

/** Compact count, e.g. 8700 → "8.7K". */
export function formatCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

/** Render a metric's absolute value per its format. */
export function formatMetricValue(value: number, format: MetricFormat): string {
  switch (format) {
    case "currency":
      return formatCurrencyCompact(value);
    case "percent":
      return formatPercent(value);
    case "count":
      return formatCount(value);
  }
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2025-05-23" → "May 23". */
export function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "2025-05-23" → "May 23, 2025". */
export function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "2025-05-23" → "May '25" (axis tick). */
export function formatMonthTick(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} '${String(y).slice(2)}`;
}
