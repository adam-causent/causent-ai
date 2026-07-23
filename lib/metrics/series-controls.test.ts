import assert from "node:assert/strict";
import test from "node:test";
import type { Observation } from "../types.ts";
import { filterSeriesRange, prepareSeries, rollupSeries } from "./series-controls.ts";

function daily(count: number): Observation[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), value: index + 1 };
  });
}

test("range controls use calendar days ending on the latest observation", () => {
  const series = daily(100);
  const filtered = filterSeriesRange(series, "30d");
  assert.equal(filtered.length, 30);
  assert.equal(filtered[0].date, "2026-03-12");
  assert.equal(filtered.at(-1)?.date, "2026-04-10");
  assert.equal(filterSeriesRange(series, "all"), series);
});

test("weekly cadence averages observations into Monday-anchored buckets", () => {
  const rolled = rollupSeries([
    { date: "2026-07-20", value: 10 },
    { date: "2026-07-21", value: 20 },
    { date: "2026-07-27", value: 40 },
  ], "weekly");
  assert.deepEqual(rolled, [
    { date: "2026-07-20", value: 15 },
    { date: "2026-07-27", value: 40 },
  ]);
});

test("preparation applies the selected range before cadence rollup", () => {
  const prepared = prepareSeries(daily(100), "30d", "weekly");
  assert.equal(prepared[0].date, "2026-03-09");
  assert.equal(prepared.at(-1)?.date, "2026-04-06");
});
