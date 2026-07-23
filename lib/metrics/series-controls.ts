import type { Observation } from "@/lib/types";

export type SeriesRange = "30d" | "60d" | "90d" | "all";
export type SeriesCadence = "daily" | "weekly";

const RANGE_DAYS: Record<Exclude<SeriesRange, "all">, number> = {
  "30d": 30,
  "60d": 60,
  "90d": 90,
};

function isoDateAtOffset(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOfWeek(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export function filterSeriesRange(series: Observation[], range: SeriesRange): Observation[] {
  if (series.length === 0 || range === "all") return series;
  const end = series[series.length - 1].date;
  const start = isoDateAtOffset(end, -(RANGE_DAYS[range] - 1));
  return series.filter((observation) => observation.date >= start && observation.date <= end);
}

export function rollupSeries(
  series: Observation[],
  cadence: SeriesCadence,
): Observation[] {
  if (cadence === "daily") return series;
  const buckets = new Map<string, { total: number; count: number }>();
  for (const observation of series) {
    const date = mondayOfWeek(observation.date);
    const bucket = buckets.get(date) ?? { total: 0, count: 0 };
    bucket.total += observation.value;
    bucket.count += 1;
    buckets.set(date, bucket);
  }
  return [...buckets.entries()].map(([date, bucket]) => ({
    date,
    value: bucket.total / bucket.count,
  }));
}

export function prepareSeries(
  series: Observation[],
  range: SeriesRange,
  cadence: SeriesCadence,
): Observation[] {
  return rollupSeries(filterSeriesRange(series, range), cadence);
}
