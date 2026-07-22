import type { MetricProjection } from "@/lib/decision-reports/schema";

export function MetricPredictionChart({ projection }: { projection: MetricProjection }) {
  const baselinePct = projection.baselinePct;
  const predictedPct = projection.predictedPct;
  const hasBaseline = baselinePct !== null;
  const hasPrediction = predictedPct !== null;
  const hasBoth = hasBaseline && hasPrediction;
  const delta = hasBoth ? predictedPct - baselinePct : null;
  const max = Math.max(100, baselinePct ?? 0, predictedPct ?? 0);
  const evidenceLabel =
    projection.evidenceState === "illustrative_assumption"
      ? "Illustrative—not observed"
      : projection.evidenceState === "prompt_supplied"
        ? "Values supplied in brief"
        : "Metric data needed";

  return (
    <figure className="rounded-xl border border-[var(--border)] bg-slate-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            Core metric hypothesis
          </p>
          <h3 className="mt-1 text-[15px] font-semibold text-[var(--text)]">
            {projection.metricName}
          </h3>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">{projection.definition}</p>
        </div>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">
          {evidenceLabel}
        </span>
      </div>

      {hasBaseline || hasPrediction ? (
        <div className="mt-4 flex flex-col gap-3">
          {hasBaseline ? (
            <MetricBar
              label={projection.baselineLabel}
              value={baselinePct}
              max={max}
              color="var(--text-muted)"
            />
          ) : null}
          {hasPrediction ? (
            <MetricBar
              label={projection.predictionLabel}
              value={predictedPct}
              max={max}
              color="var(--brand-teal)"
            />
          ) : null}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-amber-300 bg-white/70 px-3 py-4 text-[12px] leading-5 text-[var(--text-muted)]">
          Add a baseline in Data Workshop and confirm a human prediction before approving this decision.
        </div>
      )}

      <figcaption className="mt-4 flex items-start gap-3 border-t border-[var(--border)] pt-3">
        {delta !== null ? (
          <span className="rounded bg-teal-50 px-2 py-1 text-[13px] font-semibold tabular-nums text-[var(--pos)]">
            {delta >= 0 ? "+" : ""}{delta}pp
          </span>
        ) : null}
        <p className="text-[11px] leading-5 text-[var(--text-muted)]">
          {projection.evidenceState === "illustrative_assumption"
            ? "Founder prediction for the prototype. Replace both values with instrumented data before using this report to approve the decision."
            : projection.evidenceState === "prompt_supplied"
              ? "These values came from the brief. Confirm the baseline against instrumented data before approving the decision."
              : "The AI can propose a metric definition, but it cannot invent observations or a prediction."}
        </p>
      </figcaption>
    </figure>
  );
}

function MetricBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px]">
        <span className="font-medium text-[var(--text-muted)]">{label}</span>
        <span className="font-semibold tabular-nums text-[var(--text)]">{value}%</span>
      </div>
      <div
        className="h-3 overflow-hidden rounded-full bg-slate-200"
        role="img"
        aria-label={`${label}: ${value}%`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${(value / max) * 100}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
