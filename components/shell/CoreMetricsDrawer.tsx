"use client";

import { useState } from "react";
import Link from "next/link";
import type { Action, Metric } from "@/lib/types";
import { getMetricDelta } from "@/lib/derive";
import { formatLongDate, formatShortDate } from "@/lib/format";
import { LineTimeSeries, type SeriesFlag } from "@/components/charts/LineTimeSeries";
import { Sparkline } from "@/components/charts/Sparkline";
import { Delta } from "@/components/ui/Delta";
import { CalendarIcon, ChevronIcon, PlusIcon } from "@/components/ui/icons";

// Persistent bottom drawer. Core metrics "run through everything" — a daily time
// series per metric with named action flags, always checkable in the background.
// Data (metrics/actions/window) is fetched by the server layout and threaded in as
// props; this component never reads the DB or the seed directly.

const WINDOW_DAYS = 46; // matches the drawer's date-range control
const MAX_FLAGS = 5; // thin so PR pills never overlap

/** Evenly sample at most `max` items so flags stay readable. */
function thin<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => arr[Math.round(i * step)]);
}

export function CoreMetricsDrawer({
  metrics,
  actions,
  impactWindow,
}: {
  metrics: Metric[];
  actions: Action[];
  impactWindow: { start: string; end: string };
}) {
  const [open, setOpen] = useState(true);

  const chartMetrics = metrics.slice(0, 3); // stacked hero charts
  const dateLabel =
    impactWindow.start && impactWindow.end
      ? `${formatShortDate(impactWindow.start)} – ${formatLongDate(impactWindow.end)}`
      : "—";

  // All metrics share the same daily date axis, so one window start covers them all.
  const baseSeries = metrics[0]?.series ?? [];
  const windowStart =
    baseSeries.length > 0
      ? baseSeries[Math.max(0, baseSeries.length - WINDOW_DAYS)].date
      : "";

  const flagsForMetric = (color: string): SeriesFlag[] =>
    thin(
      actions.filter((a) => a.shippedAt !== null && a.shippedAt >= windowStart),
      MAX_FLAGS,
    ).map((a) => ({ date: a.shippedAt!, label: `#${a.pr}`, color }));

  return (
    <section className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">
      {/* drawer header (wraps on narrow viewports so the controls never overlap) */}
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-y-1 px-5 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]"
        >
          <ChevronIcon
            size={16}
            className={`text-[var(--text-muted)] transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: "var(--brand-teal)" }}
            aria-hidden="true"
          />
          Core Metrics
          <span className="text-[var(--text-subtle)]">{metrics.length}/5</span>
        </button>

        <div className="flex items-center gap-2 text-[12px]">
          <span className="flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-muted)]">
            <CalendarIcon className="text-[var(--text-subtle)]" />
            {dateLabel}
          </span>
          <span className="flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-muted)]">
            Daily
            <ChevronIcon size={13} className="text-[var(--text-subtle)]" />
          </span>
        </div>
      </div>

      {open && (
        <div className="flex gap-4 px-5 pb-4">
          {/* stacked hero charts */}
          <div className="flex-1 space-y-1">
            {chartMetrics.map((m) => {
              const d = getMetricDelta(m);
              return (
                <div key={m.id} className="flex items-stretch gap-3">
                  <div className="w-[120px] shrink-0 py-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: m.color }}
                        aria-hidden="true"
                      />
                      <span className="text-[13px] font-medium text-[var(--text)]">
                        {m.name}
                      </span>
                    </div>
                    <div className="mt-1 text-[18px] font-semibold tabular-nums text-[var(--text)]">
                      {d.latestLabel}
                    </div>
                    <Delta direction={d.direction} label={d.changeLabel} good={d.good} size="xs" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <LineTimeSeries
                      series={m.series.slice(-WINDOW_DAYS)}
                      color={m.color}
                      format={m.format}
                      height={78}
                      flags={flagsForMetric(m.color)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* summary panel — hidden below lg (would overlap the hero charts) */}
          <div className="hidden w-[320px] shrink-0 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 lg:block">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[var(--text)]">
                Core Metrics Summary
              </h3>
              <Link
                href="/data-workshop"
                className="flex items-center gap-1 text-[12px] font-medium text-[var(--brand-blue)] hover:underline"
              >
                <PlusIcon size={13} /> Add / Layer Metric
              </Link>
            </div>

            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 text-[10px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
              <span>Metric</span>
              <span className="text-right">Current</span>
              <span className="text-right">vs Prior 30d</span>
            </div>

            <div className="mt-1.5 space-y-1.5">
              {metrics.map((m) => {
                const d = getMetricDelta(m);
                return (
                  <div
                    key={m.id}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: m.color }}
                        aria-hidden="true"
                      />
                      <span className="truncate text-[12px] text-[var(--text)]">
                        {m.name}
                      </span>
                      <span className="hidden xl:block">
                        <Sparkline series={m.series} color={m.color} width={64} height={22} />
                      </span>
                    </div>
                    <span className="text-right text-[13px] font-semibold tabular-nums text-[var(--text)]">
                      {d.latestLabel}
                    </span>
                    <span className="justify-self-end">
                      <Delta direction={d.direction} label={d.changeLabel} good={d.good} size="xs" />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
