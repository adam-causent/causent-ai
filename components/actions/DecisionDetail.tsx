"use client";

import { useEffect, useState, useTransition } from "react";
import type { Action, Decision, Metric, Prediction } from "@/lib/types";
import { Delta } from "@/components/ui/Delta";
import { VerdictBadge } from "@/components/actions/VerdictBadge";
import { DriftNotice } from "@/components/actions/DriftNotice";
import { MechanismChain } from "@/components/actions/MechanismChain";
import { Scorecard } from "@/components/reports/Scorecard";
import { presentVerdict } from "@/lib/verdicts";
import { validateRevision } from "@/lib/predictions";
import {
  revisePrediction,
  resolveNow,
  recordScorecardView,
} from "@/app/(dashboard)/actions/server-actions";
import { actionReferenceLabel } from "@/components/actions/ActionReference";
import { LeverCreate } from "@/components/onboarding/LeverCreate";
import { ManualCompletionForm } from "@/components/actions/ManualCompletionForm";
import { CheckIcon, ChevronIcon } from "@/components/ui/icons";
import type { Claim, DecisionReportV1, DraftAction } from "@/lib/decision-reports/schema";

// The decision detail view (replaces the action-centric DecisionEditor):
// intent (rationale) → the actions carrying it (lever marked) → the
// pre-registered predictions with their honest resolution readout. The trust
// caveat LEADS every readout.

/** The quiet mid-window nudge (C5/#18): when nothing has drifted and the
 *  prediction hasn't resolved, the app stays calm and just says how long is
 *  left. Absent a resolution date it renders nothing. */
function MidWindowTouch({ resolutionDate }: { resolutionDate: string }) {
  const due = Date.parse(resolutionDate);
  if (Number.isNaN(due)) return null;
  return (
    <p className="mt-1 text-[12px] text-[var(--text-subtle)]">
      <span aria-hidden="true">⧗ </span>
      Still on track — nothing has drifted. Resolves {resolutionDate}.
    </p>
  );
}

function PredictionRow({
  prediction,
  metric,
}: {
  prediction: Prediction;
  metric: Metric | undefined;
}) {
  const [revising, setRevising] = useState(false);
  const [magnitude, setMagnitude] = useState(String(prediction.magnitudePctMean));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  // Resolution-return instrumentation (#18): one SCORECARD_VIEW per resolved
  // prediction shown. Fire-and-forget; the verdict/prediction id keys dedupe.
  useEffect(() => {
    if (!prediction.verdict) return;
    void recordScorecardView({ predictionId: prediction.id, verdict: prediction.verdict });
  }, [prediction.id, prediction.verdict]);

  const dirUp = prediction.direction === "POSITIVE";
  const good = metric ? dirUp === metric.higherIsBetter : dirUp;
  const p = prediction.verdict ? presentVerdict(prediction.verdict) : null;
  const revisable = prediction.resolvedAt === null;

  function submitRevision() {
    const newMagnitudePct = Number(magnitude);
    const errs = validateRevision({ newMagnitudePct, reason });
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    startTransition(async () => {
      const res = await revisePrediction({
        predictionId: prediction.id,
        newMagnitudePct,
        reason,
      });
      if (!res.ok) setErrors(res.errors);
      else {
        setErrors([]);
        setRevising(false);
        setReason("");
      }
    });
  }

  return (
    <div className="rounded-lg border border-[var(--border)] p-3">
      {/* The caveat leads — before any number. */}
      {p && <p className="text-[12px] leading-snug text-[var(--text-muted)]">{p.caveat}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {prediction.verdict && <VerdictBadge verdict={prediction.verdict} size="md" />}
        <span className="flex items-center gap-1.5 text-[13px] text-[var(--text)]">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: metric?.color }}
            aria-hidden="true"
          />
          {metric?.name ?? prediction.metricId}
        </span>
        <Delta
          direction={dirUp ? "up" : "down"}
          label={`we predicted ${dirUp ? "+" : "−"}${prediction.magnitudePctMean}% of mean`}
          good={good}
        />
        {prediction.measuredPct !== null && (
          <span className="text-[12px] tabular-nums text-[var(--text-muted)]">
            measured {prediction.measuredPct >= 0 ? "+" : ""}
            {prediction.measuredPct.toFixed(1)}%
          </span>
        )}
        <span className="text-[11px] text-[var(--text-subtle)]">
          {prediction.resolvedAt
            ? `resolved ${prediction.resolvedAt}`
            : `resolves ${prediction.resolutionDate}`}
        </span>
      </div>

      {/* Baseline-drift notice — the hero signal, on the prediction card (C5/#18). */}
      <DriftNotice prediction={prediction} metric={metric} />

      {/* Mid-window touch: a calm "still on track, N days to resolution" nudge
          when nothing has changed — unresolved and no baseline drift (C5/#18). */}
      {!prediction.verdict && prediction.drift?.status !== "FIRED" && (
        <MidWindowTouch resolutionDate={prediction.resolutionDate} />
      )}

      {/* Resolution scorecard: the Step-7 payoff — predicted-vs-measured once
          the engine resolves, plus the GATHERING / UNMEASURABLE surfaces (#18). */}
      {prediction.verdict && (
        <div className="mt-2">
          <Scorecard prediction={prediction} metric={metric} />
        </div>
      )}

      {prediction.revisions.length > 0 && (
        <ul className="mt-2 border-l-2 border-[var(--border)] pl-2 text-[11px] text-[var(--text-subtle)]">
          {prediction.revisions.map((r, i) => (
            <li key={i}>
              revised {r.oldMagnitudePct}% → {r.newMagnitudePct}% on {r.revisedAt}: “{r.reason}”
            </li>
          ))}
        </ul>
      )}

      {revisable && !revising && (
        <button
          type="button"
          onClick={() => setRevising(true)}
          className="mt-2 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg)]"
        >
          Revise (with a logged reason)
        </button>
      )}
      {revising && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-[var(--text-muted)]" htmlFor={`mag-${prediction.id}`}>
              New magnitude (% of mean)
            </label>
            <input
              id={`mag-${prediction.id}`}
              value={magnitude}
              onChange={(e) => setMagnitude(e.target.value)}
              inputMode="decimal"
              className="w-24 rounded border border-[var(--border)] px-2 py-1 text-[12px] tabular-nums"
            />
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why did the team's number change? A revision is data, not a failure."
            rows={2}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-[12px]"
          />
          {errors.map((e, i) => (
            <p key={i} className="text-[11px] text-[var(--neg)]">{e}</p>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={submitRevision}
              className="rounded bg-[var(--text)] px-2.5 py-1 text-[11px] font-medium text-[var(--surface)] disabled:opacity-50"
            >
              {pending ? "Saving…" : "Log revision"}
            </button>
            <button
              type="button"
              onClick={() => setRevising(false)}
              className="rounded border border-[var(--border)] px-2.5 py-1 text-[11px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function presentClaims(claims: Claim[]): Claim[] {
  return claims.filter((claim) => claim.status !== "missing" && claim.text.trim());
}

function reportActionFor(action: Action, report: DecisionReportV1): DraftAction | undefined {
  return report.implementation.actions.find((candidate) =>
    action.sourceItemId
      ? candidate.sourceItemId === action.sourceItemId
      : candidate.title.trim().toLowerCase() === action.title.trim().toLowerCase(),
  );
}

function DecisionSummary({ report }: { report: DecisionReportV1 }) {
  const decisions = presentClaims(report.decision.decision);
  const problems = presentClaims(report.decision.problem);
  const evidence = presentClaims(report.supportingEvidence.factors);
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm shadow-slate-200/40">
      <h2 className="text-[15px] font-semibold text-[var(--text)]">Decision Summary</h2>
      <div className="mt-4 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Decision</h3>
          {decisions.map((claim) => (
            <p key={claim.id} className="mt-2 text-[15px] font-semibold leading-6 text-[var(--text)]">{claim.text}</p>
          ))}
          {problems.map((claim) => (
            <p key={claim.id} className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">{claim.text}</p>
          ))}
        </div>
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Supporting evidence</h3>
          <ul className="mt-2 space-y-2">
            {evidence.map((claim) => (
              <li key={claim.id} className="flex gap-2 text-[12px] leading-5 text-[var(--text-muted)]">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-teal)]" aria-hidden="true" />
                <span>{claim.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ReportActionRows({
  actions,
  report,
  selectedActionId,
}: {
  actions: Action[];
  report: DecisionReportV1;
  selectedActionId: string | null;
}) {
  const governanceSources = presentClaims(report.implementation.governance.allowedDataSources);
  const governanceNotes = presentClaims(report.implementation.governance.approvedModelNotes);
  return (
    <section>
      <h2 className="text-[15px] font-semibold text-[var(--text)]">Actions</h2>
      <div className="mt-3 space-y-2">
        {actions.map((action) => {
          const detail = reportActionFor(action, report);
          const summaries = detail ? presentClaims(detail.summary) : [];
          const reference = actionReferenceLabel(action);
          return (
            <details
              key={action.id}
              id={action.id}
              open={selectedActionId === action.id ? true : undefined}
              className="group scroll-mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]"
            >
              <summary className="grid cursor-pointer list-none grid-cols-[22px_minmax(0,1fr)_minmax(120px,0.35fr)_auto] items-center gap-3 px-4 py-3 marker:hidden">
                <ChevronIcon className="text-[var(--text-subtle)] transition-transform group-open:rotate-180" />
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-md border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-teal-800">
                    {action.displayCode ?? "Action"}
                  </span>
                  <span className="truncate text-[13px] font-semibold text-[var(--text)]">{action.title}</span>
                </span>
                <span className="truncate text-[11px] font-medium text-[var(--text-muted)]">
                  {reference === "Planned" ? "No Jira/GitHub ticket" : reference}
                </span>
                <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold ${
                  action.shippedAt
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-[var(--border)] bg-white text-[var(--text-muted)]"
                }`}>
                  <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${action.shippedAt ? "border-emerald-600 bg-emerald-600 text-white" : "border-[var(--border-strong)]"}`}>
                    {action.shippedAt ? <CheckIcon size={10} strokeWidth={2.5} /> : null}
                  </span>
                  {action.shippedAt ? "Complete" : "Open"}
                </span>
              </summary>
              <div className="border-t border-[var(--border)] px-4 py-4 pl-[58px]">
                {summaries.length > 0 ? (
                  <div>
                    <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Details</h3>
                    {summaries.map((claim) => <p key={claim.id} className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{claim.text}</p>)}
                  </div>
                ) : action.rationale?.body.length ? (
                  <div>
                    <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Details</h3>
                    {action.rationale.body.map((paragraph, index) => <p key={index} className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{paragraph}</p>)}
                  </div>
                ) : null}
                <dl className="mt-3 grid gap-3 text-[11px] sm:grid-cols-3">
                  <div><dt className="font-semibold text-[var(--text-subtle)]">Owner</dt><dd className="mt-1 text-[var(--text)]">{detail?.owner?.text || action.ownerLabel || "Not assigned"}</dd></div>
                  <div><dt className="font-semibold text-[var(--text-subtle)]">Work item</dt><dd className="mt-1 text-[var(--text)]">{reference}</dd></div>
                  <div><dt className="font-semibold text-[var(--text-subtle)]">Completed</dt><dd className="mt-1 text-[var(--text)]">{action.shippedAt ?? "Not yet"}</dd></div>
                </dl>
                <div className="mt-3 rounded-lg bg-[var(--bg)] px-3 py-2 text-[10px] leading-4 text-[var(--text-muted)]">
                  <span className="font-semibold text-[var(--text)]">Governance: </span>
                  {report.implementation.governance.dataClassification
                    ? `${report.implementation.governance.dataClassification} data. `
                    : "Data classification not set. "}
                  {[...governanceSources, ...governanceNotes].map((claim) => claim.text).join(" ") || "No additional governance notes."}
                </div>
                {action.manualCompletion ? (
                  <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">
                    Completed {action.manualCompletion.completedOn}: {action.manualCompletion.explanation}
                  </p>
                ) : action.source === "manual" ? (
                  <div className="mt-3"><ManualCompletionForm actionId={action.id} /></div>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function ConnectorExplanation() {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg)]/60 p-4">
      <h2 className="text-[13px] font-semibold text-[var(--text)]">Connect work tracking</h2>
      <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">
        Account-level GitHub or Atlassian sign-in is not available yet. Today, choose a repository or Jira project below: Causent creates the ticket when workspace credentials are configured, or gives you a prefilled link and accepts the finished issue URL. Webhooks monitor connected work after attribution.
      </p>
      <p className="mt-2 text-[10px] leading-4 text-[var(--text-subtle)]">
        Once connected, the action header shows the GitHub issue or Jira key and its completion state. Manual completion remains available for work shipped elsewhere.
      </p>
    </section>
  );
}

export function DecisionDetail({
  decision,
  actions,
  metrics,
  onSelectAction,
  connectorMetricId,
  report = null,
  selectedActionId = null,
}: {
  decision: Decision;
  actions: Action[];
  metrics: Metric[];
  onSelectAction: (id: string) => void;
  connectorMetricId: string | null;
  report?: DecisionReportV1 | null;
  selectedActionId?: string | null;
}) {
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const [resolvePending, startResolve] = useTransition();
  const [resolveMsg, setResolveMsg] = useState<string | null>(null);
  const hasUnresolved = decision.predictions.some((p) => p.resolvedAt === null);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {report ? <DecisionSummary report={report} /> : <div>
        <h2 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
          {decision.title}
        </h2>
        <p className="mt-0.5 text-[12px] text-[var(--text-subtle)]">
          decided {decision.createdAt}
          {decision.rationale.mechanismCategory && (
            <> · {decision.rationale.mechanismCategory}</>
          )}
        </p>
      </div>}

      {!report && decision.rationale.body.length > 0 && (
        <div className="flex flex-col gap-2">
          {decision.rationale.body.map((para, i) => (
            <p key={i} className="text-[13px] leading-relaxed text-[var(--text-muted)]">
              {para}
            </p>
          ))}
        </div>
      )}

      {report ? (
        <ReportActionRows
          actions={decision.actionIds.flatMap((id) => actionById.get(id) ?? [])}
          report={report}
          selectedActionId={selectedActionId}
        />
      ) : <section>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
          Actions carrying this decision
        </h3>
        <ul className="mt-2 flex flex-col gap-1">
          {decision.actionIds.map((id) => {
            const a = actionById.get(id);
            const isLever = id === decision.leverActionId;
            return (
              <li key={id} className="flex items-center gap-2 text-[13px]">
                <button
                  type="button"
                  onClick={() => onSelectAction(id)}
                  className="text-[var(--text)] underline-offset-2 hover:underline"
                >
                  {a ? `${actionReferenceLabel(a)} ${a.title}` : id}
                </button>
                {isLever && (
                  <span className="rounded-full border border-[var(--text)]/20 bg-[var(--bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    lever
                  </span>
                )}
                {a && a.shippedAt === null && (
                  <span className="text-[11px] text-[var(--text-subtle)]">
                    {a.source === "manual" ? "planned" : "not shipped"}
                  </span>
                )}
              </li>
            );
          })}
          {decision.actionIds.length === 0 && (
            <li className="text-[12px] text-[var(--text-subtle)]">
              No actions mapped yet.
            </li>
          )}
        </ul>
      </section>}

      {report && decision.origin === "decision_report" && !decision.leverActionId && connectorMetricId ? (
        <>
          <ConnectorExplanation />
          <LeverCreate
            decisionId={decision.id}
            metricId={connectorMetricId}
            title={decision.title}
            mechanismSummary={decision.rationale.body.join("\n\n") || decision.title}
            mechanismCategory={decision.rationale.mechanismCategory}
          />
        </>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
            We predict
          </h3>
          {hasUnresolved && process.env.NODE_ENV !== "production" && (
            <button
              type="button"
              disabled={resolvePending}
              onClick={() =>
                startResolve(async () => {
                  const res = await resolveNow();
                  setResolveMsg(res.ok ? "Resolution sweep ran." : res.errors[0]);
                })
              }
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg)]"
            >
              {resolvePending ? "Resolving…" : "Resolve now (dev)"}
            </button>
          )}
        </div>
        {resolveMsg && <p className="text-[11px] text-[var(--text-subtle)]">{resolveMsg}</p>}
        <MechanismChain decision={decision} actions={actions} metrics={metrics} />
        {decision.predictions.map((p) => (
          <PredictionRow key={p.id} prediction={p} metric={metricById.get(p.metricId)} />
        ))}
        {decision.predictions.length === 0 && (
          <p className="text-[12px] text-[var(--text-subtle)]">No prediction committed.</p>
        )}
      </section>

      {!report && decision.origin === "decision_report" && !decision.leverActionId && connectorMetricId ? (
        <LeverCreate
          decisionId={decision.id}
          metricId={connectorMetricId}
          title={decision.title}
          mechanismSummary={decision.rationale.body.join("\n\n") || decision.title}
          mechanismCategory={decision.rationale.mechanismCategory}
        />
      ) : null}
    </div>
  );
}
