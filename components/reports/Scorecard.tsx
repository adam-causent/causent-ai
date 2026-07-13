import type { Metric, Prediction } from "@/lib/types";
import { Delta } from "@/components/ui/Delta";
import { VerdictBadge } from "@/components/actions/VerdictBadge";
import { shapeScorecard } from "@/lib/scorecard";

// The resolution scorecard (Step 7 payoff, C5/#18): "You said +3%. Here's what
// happened." At resolution_date the engine writes the verdict + memory tuple;
// this surface renders predicted-vs-measured, caveat-first, reusing Delta +
// VerdictBadge (the same triple-encoded, colorblind-safe primitives as the rest
// of the app). It NEVER re-implements the resolution math — lib/scorecard.ts
// shapes what resolve.py already measured.
//
// Every verdict class has an honest surface, never a blank or an error:
//   measured      predicted vs measured, with the CI on the same %-of-mean scale
//   gathering     "not yet" — the engine already extended the date
//   unmeasurable  connect-the-metric / self-report prompt (declared, never wired)
//   no-signal     measured, but no confident number (INCONCLUSIVE / UNRESOLVABLE)
//   no-lever      nothing shipped/mapped to measure (VOIDED / UNATTRIBUTED)

const cardCls =
  "flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4";
const kicker =
  "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]";
const rowCls = "flex items-baseline justify-between gap-3";
const rowLabel = "text-[12px] text-[var(--text-muted)]";

function signedPct(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function Scorecard({
  prediction,
  metric,
}: {
  prediction: Prediction;
  metric?: Metric;
}) {
  // Unresolved predictions don't have a scorecard yet — the caller gates on
  // prediction.verdict, but stay defensive.
  if (!prediction.verdict) return null;

  const sc = shapeScorecard({
    verdict: prediction.verdict,
    committedDirection: prediction.direction,
    committedMagnitudePct: prediction.magnitudePctMean,
    tuple: prediction.resolutionTuple ?? null,
  });

  const predictedGlyphDir = sc.predicted.direction === "POSITIVE" ? "up" : "down";
  // Measured tone follows the verdict, not the raw sign: CONFIRMED/DIRECTION_
  // CONFIRMED read positive, REFUTED negative, everything else neutral.
  const measuredTone: "auto" | "neutral" =
    sc.presentation.tone === "positive" || sc.presentation.tone === "negative"
      ? "auto"
      : "neutral";
  const measuredGood = sc.presentation.tone === "positive";

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between gap-2">
        <span className={kicker}>Resolution scorecard</span>
        <VerdictBadge verdict={sc.verdict} size="md" />
      </div>

      {/* The trust caveat LEADS — before any number. */}
      <p className="text-[13px] leading-relaxed text-[var(--text)]">
        {sc.presentation.caveat}
      </p>

      {/* Predicted — always shown: the human commitment on the record. */}
      <div className={rowCls}>
        <span className={rowLabel}>You predicted</span>
        <Delta
          direction={predictedGlyphDir}
          good={measuredGood}
          tone="neutral"
          size="md"
          label={signedPct(
            sc.predicted.direction === "POSITIVE"
              ? sc.predicted.magnitudePct
              : -sc.predicted.magnitudePct,
          )}
        />
      </div>

      {/* Measured — the predicted-vs-measured payoff. */}
      {sc.measured && sc.measured.pct !== null && (
        <div className={rowCls}>
          <span className={rowLabel}>Engine measured</span>
          <div className="flex flex-col items-end gap-0.5">
            <Delta
              direction={sc.measured.direction}
              good={measuredGood}
              tone={measuredTone}
              size="md"
              label={signedPct(sc.measured.pct)}
            />
            {sc.measured.ciLowPct !== null && sc.measured.ciHighPct !== null && (
              <span className="text-[11px] text-[var(--text-subtle)] tabular-nums">
                95% CI {signedPct(sc.measured.ciLowPct)} … {signedPct(sc.measured.ciHighPct)}
              </span>
            )}
          </div>
        </div>
      )}
      {sc.measured?.beliefReason && (
        <p className="text-[11px] text-[var(--text-subtle)]">
          Engine note: {sc.measured.beliefReason}.
        </p>
      )}

      {/* Gathering — a not-yet is not a no; the engine extended the date. */}
      {sc.kind === "gathering" && (
        <p className="rounded border border-dashed border-[var(--border)] p-2 text-[12px] text-[var(--text-muted)]">
          Re-measures automatically on{" "}
          <span className="tabular-nums text-[var(--text)]">{prediction.resolutionDate}</span>.
          Nothing to do — we&apos;ll surface the readout the moment there&apos;s enough
          daily history.
        </p>
      )}

      {/* Unmeasurable — connect the metric, or self-report. NEVER a blank. */}
      {sc.kind === "unmeasurable" && (
        <div className="flex flex-col gap-2 rounded border border-dashed border-[var(--border)] p-3">
          <p className="text-[12px] text-[var(--text-muted)]">
            You declared{metric ? ` ${metric.name}` : " this metric"} but never
            connected a data source, so there&apos;s no series to measure against.
            Two honest ways to score it:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/data-workshop"
              className="rounded bg-[var(--text)] px-3 py-1.5 text-[13px] font-medium text-[var(--surface)]"
            >
              Connect the metric
            </a>
            <a
              href="/actions"
              className="rounded border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              Self-report the outcome
            </a>
          </div>
        </div>
      )}

      {/* Predicted vs due — the resolution date footer, tabular. */}
      <p className="text-[11px] text-[var(--text-subtle)] tabular-nums">
        Resolution date {prediction.resolutionDate}
        {prediction.resolvedAt ? ` · resolved ${prediction.resolvedAt}` : ""}
      </p>
    </div>
  );
}
