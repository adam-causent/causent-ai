import type {
  Action,
  ImpactStat,
  Metric,
  MetricImpact,
  ProjectObjective,
  Report,
  Scope,
} from "@/lib/types";

// The rendered stakeholder report: a whole-project document that rolls up the
// objective, the impact analysis, and the decisions behind it. `report.depth`
// controls how much shows — "full" lists every action; "succinct" shows only the
// top movers. Composed from the same honest figures the dashboard renders, so a
// report never tells a story the graph doesn't support.
export function ReportPreview({
  report,
  scope,
  objective,
  aggregatedImpact,
  impactByMetric,
  metrics,
  actions,
}: {
  report: Report;
  scope: Scope;
  objective: ProjectObjective | null;
  aggregatedImpact: ImpactStat[];
  impactByMetric: MetricImpact[];
  metrics: Metric[];
  actions: Action[];
}) {
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const improvement =
    aggregatedImpact.find((s) => /win rate|improvement/i.test(s.label)) ?? null;

  const topMetrics = [...impactByMetric]
    .filter((r) => r.direction !== "neutral")
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 4);

  // Each action's headline outcome = its primary metric's cell.
  const withOutcome = actions.map((a) => {
    const cell = a.impact.find((c) => c.metricId === a.primaryMetricId);
    return { action: a, cell };
  });
  const ranked = [...withOutcome].sort(
    (x, y) => Math.abs(y.cell?.value ?? 0) - Math.abs(x.cell?.value ?? 0),
  );
  const shown = report.depth === "succinct" ? ranked.slice(0, 3) : ranked;

  return (
    <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto max-w-[760px] px-6 py-6">
        {/* Title block */}
        <header className="border-b border-[var(--border)] pb-4">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            <span>Stakeholder Report</span>
            <DepthBadge depth={report.depth} />
          </div>
          <h1 className="mt-2 text-[26px] font-bold tracking-tight text-[var(--text)]">
            {report.title}
          </h1>
          <div className="mt-1.5 text-[13px] text-[var(--text-subtle)] tabular-nums">
            {scope.project} / {scope.workspace} · {report.createdAt} ·{" "}
            {report.author}
          </div>
        </header>

        {/* Objective */}
        {objective && (
          <Section title="Objective">
            <p className="max-w-[68ch] text-[14px] leading-relaxed text-[var(--text)]">
              {objective.statement}
            </p>
            <ul className="mt-3 space-y-1.5">
              {objective.keyResults.map((kr) => (
                <li
                  key={kr}
                  className="flex items-start gap-2 text-[13px] text-[var(--text)]"
                >
                  <span
                    className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-teal)]"
                    aria-hidden="true"
                  />
                  <span>{kr}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Impact analysis */}
        <Section title="Impact Analysis">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Figure
              label="Metrics Tracked"
              value={String(metrics.length)}
              tone="plain"
            />
            <Figure
              label="Improvement Rate"
              value={improvement?.value ?? "—"}
              tone="positive"
            />
            {topMetrics.map((r) => {
              const m = metricById.get(r.metricId);
              return (
                <Figure
                  key={r.metricId}
                  label={m?.name ?? r.metricId}
                  value={r.label}
                  dot={m?.color}
                  tone={r.good ? "positive" : "negative"}
                />
              );
            })}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--text-muted)]">
            Figures are net confident causal lift (OLS Interrupted Time Series).
            Metrics with fewer than 45 days since a ship are still gathering data
            and are withheld from a confident claim.
          </p>
        </Section>

        {/* Decisions & actions */}
        <Section
          title={
            report.depth === "succinct" ? "Top Decisions" : "Decisions & Actions"
          }
        >
          <div className="divide-y divide-[var(--border)]">
            {shown.map(({ action, cell }) => {
              const m = metricById.get(action.primaryMetricId);
              return (
                <div
                  key={action.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-[var(--text)]">
                      {action.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[12px] text-[var(--text-subtle)]">
                      <span className="tabular-nums">#{action.pr}</span>
                      <span>·</span>
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: m?.color }}
                          aria-hidden="true"
                        />
                        {m?.name ?? action.primaryMetricId}
                      </span>
                    </div>
                  </div>
                  <div
                    className={`shrink-0 text-[15px] font-semibold tabular-nums ${
                      cell && cell.direction !== "neutral"
                        ? cell.good
                          ? "text-[var(--pos)]"
                          : "text-[var(--neg)]"
                        : "text-[var(--text-muted)]"
                    }`}
                  >
                    {cell?.label ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>
          {report.depth === "succinct" && ranked.length > shown.length && (
            <div className="mt-2 text-[12px] text-[var(--text-subtle)]">
              + {ranked.length - shown.length} more actions in the full report.
            </div>
          )}
        </Section>
      </article>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
  dot,
}: {
  label: string;
  value: string;
  tone: "positive" | "negative" | "plain";
  dot?: string;
}) {
  const toneClass =
    tone === "positive"
      ? "text-[var(--pos)]"
      : tone === "negative"
        ? "text-[var(--neg)]"
        : "text-[var(--text)]";
  return (
    <div className="rounded-lg border border-[var(--border)] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
        {dot && (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: dot }}
            aria-hidden="true"
          />
        )}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={`mt-1 text-[22px] font-bold leading-none tabular-nums ${toneClass}`}
      >
        {value}
      </div>
    </div>
  );
}

function DepthBadge({ depth }: { depth: Report["depth"] }) {
  return (
    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
      {depth === "full" ? "Full" : "Succinct"}
    </span>
  );
}
