"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { DecisionCard } from "@/lib/onboarding/parse";
import { MECHANISM_CATEGORIES } from "@/lib/onboarding/parse";
import type { ReferenceClassPriors } from "@/lib/priors";
import { LeverCreate } from "@/components/onboarding/LeverCreate";
import {
  commitOnboardingPrediction,
  declareOnboardingMetric,
  fetchOnboardingPriors,
  structurePaste,
} from "@/app/(onboarding)/onboarding/server-actions";

// The cold-start wizard, Steps 2-4 (C2/#15).
//
//   paste  ->  card (structure + interrogate)  ->  commit  ->  prediction card
//
// Honesty rules, structurally enforced here:
//   - Elicit-not-assert: the magnitude input is NEVER pre-filled; the
//     precedent panel only describes ("no precedent yet" on a thin graph).
//   - The interrogation blocks the commitment step until the mechanism is
//     named — vagueness doesn't pass.
//   - A garbage paste falls back to manual entry (title + metric typed by
//     hand) — the funnel never dead-ends.

type Step = "paste" | "card" | "commit" | "done";

type DeclaredMetric = {
  metricId: string;
  name: string;
  reused: boolean;
  hasObservations: boolean;
};

type Committed = {
  predictionId: string;
  decisionId: string;
  metricId: string;
  mechanismSummary: string;
  mechanismCategory: string;
  title: string;
  metricName: string;
  direction: "POSITIVE" | "NEGATIVE";
  magnitudePct: number;
  resolutionDate: string;
};

const field =
  "rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--text)]";
const label = "text-[12px] font-medium text-[var(--text-muted)]";
const primaryBtn =
  "rounded bg-[var(--text)] px-4 py-2 text-[14px] font-medium text-[var(--surface)] disabled:opacity-40";
const ghostBtn =
  "rounded border border-[var(--border)] px-4 py-2 text-[14px] text-[var(--text-muted)] hover:text-[var(--text)]";

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ["paste", "card", "commit", "done"];
  const names = ["Describe", "Structure", "Commit", "Watch"];
  const idx = order.indexOf(step);
  return (
    <ol className="mb-8 flex items-center gap-2 text-[11px] text-[var(--text-subtle)]">
      {names.map((name, i) => (
        <li key={name} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="w-6 border-t border-[var(--border)]" />}
          <span
            className={
              i <= idx
                ? "font-semibold text-[var(--text)]"
                : undefined
            }
          >
            {name}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PrecedentPanel({
  priors,
  loading,
}: {
  priors: ReferenceClassPriors | null;
  loading: boolean;
}) {
  return (
    <div className="rounded border border-dashed border-[var(--border)] p-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
        Precedent (informs — never authors — your number)
      </p>
      {loading ? (
        <p className="text-[12px] text-[var(--text-subtle)]">Checking past resolutions…</p>
      ) : priors === null || !priors.hasPrecedent ? (
        <p className="text-[12px] text-[var(--text-muted)]">
          No precedent yet — record your prior. Your resolved predictions become the
          base rate for the next one.
        </p>
      ) : (
        <div className="flex flex-col gap-1 text-[12px] text-[var(--text-muted)]">
          <p>
            {priors.supportCount} resolved prediction
            {priors.supportCount === 1 ? "" : "s"} in this class.
          </p>
          {priors.baseRate.weightedMeanPct !== null ? (
            <p>
              Measured lifts ran{" "}
              <span className="tabular-nums">
                {priors.baseRate.minPct?.toFixed(1)}% … {priors.baseRate.maxPct?.toFixed(1)}%
              </span>{" "}
              (belief-weighted mean {priors.baseRate.weightedMeanPct.toFixed(1)}%).
            </p>
          ) : (
            <p>Nothing in this class resolved with a confident measurement yet.</p>
          )}
          {priors.calibration.weightedMeanErrorPct !== null && (
            <p>
              This team{" "}
              {priors.calibration.weightedMeanErrorPct > 0 ? "over-predicts" : "under-predicts"}{" "}
              this class by{" "}
              <span className="tabular-nums">
                {Math.abs(priors.calibration.weightedMeanErrorPct).toFixed(1)}pp
              </span>{" "}
              on average.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function OnboardingFunnel() {
  const [step, setStep] = useState<Step>("paste");
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);

  // Step 2 — paste
  const [paste, setPaste] = useState("");

  // Step 3 — editable card + interrogation answers
  const [card, setCard] = useState<DecisionCard | null>(null);
  const [title, setTitle] = useState("");
  const [metricName, setMetricName] = useState("");
  const [mechanismCategory, setMechanismCategory] = useState<string>("other");
  const [mechanismSummary, setMechanismSummary] = useState("");
  const [answers, setAnswers] = useState<string[]>([]);

  // Step 4 — the team's commitment
  const [declared, setDeclared] = useState<DeclaredMetric | null>(null);
  const [direction, setDirection] = useState<"POSITIVE" | "NEGATIVE">("POSITIVE");
  const [magnitude, setMagnitude] = useState(""); // NEVER pre-filled — the team's number
  const [resolutionDate, setResolutionDate] = useState("");
  const [priors, setPriors] = useState<ReferenceClassPriors | null>(null);
  const [priorsLoading, setPriorsLoading] = useState(false);

  const [committed, setCommitted] = useState<Committed | null>(null);

  useEffect(() => {
    if (step !== "commit" || !declared) return;
    let stale = false;
    setPriorsLoading(true);
    fetchOnboardingPriors({ metricId: declared.metricId, mechanismCategory })
      .then((p) => {
        if (!stale) setPriors(p);
      })
      .finally(() => {
        if (!stale) setPriorsLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [step, declared, mechanismCategory]);

  const daysToResolution = useMemo(() => {
    if (!committed) return null;
    const due = Date.parse(committed.resolutionDate);
    if (Number.isNaN(due)) return null;
    return Math.max(0, Math.ceil((due - Date.now()) / 86_400_000));
  }, [committed]);

  function applyCard(c: DecisionCard) {
    setCard(c);
    setTitle(c.title);
    setMetricName(c.metricName ?? "");
    setMechanismCategory(c.mechanismCategory);
    setMechanismSummary(c.mechanismSummary);
    setAnswers(c.questions.map(() => ""));
    setStep("card");
  }

  function structure() {
    setErrors([]);
    startTransition(async () => {
      applyCard(await structurePaste(paste));
    });
  }

  function continueToCommit() {
    const errs: string[] = [];
    if (!title.trim()) errs.push("Give the decision a title.");
    if (!metricName.trim()) errs.push("Name the metric this decision should move.");
    if (!mechanismSummary.trim()) {
      errs.push(
        "Name the mechanism — what changes, and why would that move the metric? The commitment stays locked until it's explicit.",
      );
    }
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const res = await declareOnboardingMetric(metricName);
      if ("error" in res) {
        setErrors([res.error]);
        return;
      }
      setDeclared(res);
      setMetricName(res.name);
      setStep("commit");
    });
  }

  function commit() {
    if (!declared) return;
    setErrors([]);
    startTransition(async () => {
      const res = await commitOnboardingPrediction({
        title,
        mechanismSummary,
        mechanismCategory,
        notes: answers.filter((a) => a.trim().length > 0),
        metricId: declared.metricId,
        direction,
        magnitudePctMean: Number(magnitude),
        resolutionDate,
      });
      if (!res.ok) {
        setErrors(res.errors);
        return;
      }
      setCommitted({
        predictionId: res.predictionId,
        decisionId: res.decisionId,
        metricId: declared.metricId,
        mechanismSummary,
        mechanismCategory,
        title,
        metricName: declared.name,
        direction,
        magnitudePct: Number(magnitude),
        resolutionDate,
      });
      setStep("done");
    });
  }

  return (
    <div className="flex flex-col">
      <StepDots step={step} />

      {step === "paste" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-[22px] font-semibold leading-snug text-[var(--text)]">
            What are you about to build, and what do you expect it to change?
          </h1>
          <p className="text-[13px] text-[var(--text-muted)]">
            Paste a doc, a Slack thread, or a ticket — or just type it. No setup, no
            connectors.
          </p>
          <textarea
            autoFocus
            className={`${field} min-h-44`}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="e.g. We're rebuilding the pricing page around usage tiers. Finance thinks it lifts expansion revenue; design worries it confuses small teams…"
          />
          <div className="flex items-center gap-3">
            <button type="button" className={primaryBtn} disabled={pending} onClick={structure}>
              {pending ? "Structuring…" : "Structure it"}
            </button>
            <span className="text-[12px] text-[var(--text-subtle)]">
              Causent drafts the decision card; you stay the author.
            </span>
          </div>
        </section>
      )}

      {step === "card" && card && (
        <section className="flex flex-col gap-4">
          <h1 className="text-[20px] font-semibold text-[var(--text)]">
            Here&apos;s the decision as stated. Make it concrete.
          </h1>
          {card.source === "fallback" && (
            <p className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] text-[var(--text-muted)]">
              We couldn&apos;t structure that automatically — no problem. Title and metric
              are yours to type below; the questions still apply.
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label className={label} htmlFor="ob-title">Decision</label>
            <input
              id="ob-title"
              className={field}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Rebuild the pricing page around usage tiers"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className={label} htmlFor="ob-metric">
                Primary metric {card.metricName === null && "— name it yourself"}
              </label>
              <input
                id="ob-metric"
                className={field}
                value={metricName}
                onChange={(e) => setMetricName(e.target.value)}
                placeholder="e.g. Expansion revenue"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={label} htmlFor="ob-mech-cat">Mechanism class</label>
              <select
                id="ob-mech-cat"
                className={field}
                value={mechanismCategory}
                onChange={(e) => setMechanismCategory(e.target.value)}
              >
                {MECHANISM_CATEGORIES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className={label} htmlFor="ob-mech">
              Mechanism — what changes, and why would that move the metric?{" "}
              <span className="text-[var(--neg)]">(required to commit)</span>
            </label>
            <textarea
              id="ob-mech"
              className={field}
              rows={3}
              value={mechanismSummary}
              onChange={(e) => setMechanismSummary(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 rounded border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
              Before you commit — answer what the note left unsaid
            </p>
            {card.questions.map((q, i) => (
              <div key={i} className="flex flex-col gap-1">
                <label className="text-[13px] text-[var(--text)]" htmlFor={`ob-q-${i}`}>
                  {q}
                </label>
                <textarea
                  id={`ob-q-${i}`}
                  className={field}
                  rows={2}
                  value={answers[i] ?? ""}
                  onChange={(e) =>
                    setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))
                  }
                />
              </div>
            ))}
          </div>

          {errors.map((e, i) => (
            <p key={i} className="text-[12px] text-[var(--neg)]">{e}</p>
          ))}

          <div className="flex items-center gap-3">
            <button
              type="button"
              className={primaryBtn}
              disabled={pending || !mechanismSummary.trim()}
              onClick={continueToCommit}
            >
              {pending ? "Saving…" : "Continue to the commitment"}
            </button>
            <button type="button" className={ghostBtn} onClick={() => setStep("paste")}>
              Back
            </button>
          </div>
        </section>
      )}

      {step === "commit" && declared && (
        <section className="flex flex-col gap-4">
          <h1 className="text-[20px] font-semibold text-[var(--text)]">
            Commit the prediction — your team&apos;s number, on the record.
          </h1>
          <p className="text-[13px] text-[var(--text-muted)]">
            <span className="font-medium text-[var(--text)]">{title}</span> →{" "}
            <span className="font-medium text-[var(--text)]">{declared.name}</span>
            {declared.reused
              ? " (matched an existing metric — precedent below)"
              : " (declared — Causent will ask for the data source later)"}
          </p>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label className={label} htmlFor="ob-dir">Direction</label>
              <select
                id="ob-dir"
                className={field}
                value={direction}
                onChange={(e) => setDirection(e.target.value as "POSITIVE" | "NEGATIVE")}
              >
                <option value="POSITIVE">Up (positive)</option>
                <option value="NEGATIVE">Down (negative)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className={label} htmlFor="ob-mag">Magnitude (% of the metric&apos;s mean)</label>
              <input
                id="ob-mag"
                className={`${field} tabular-nums`}
                inputMode="decimal"
                value={magnitude}
                onChange={(e) => setMagnitude(e.target.value)}
                placeholder="your team's number"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={label} htmlFor="ob-date">Resolution date</label>
              <input
                id="ob-date"
                type="date"
                className={field}
                value={resolutionDate}
                onChange={(e) => setResolutionDate(e.target.value)}
              />
            </div>
          </div>

          <PrecedentPanel priors={priors} loading={priorsLoading} />

          {errors.map((e, i) => (
            <p key={i} className="text-[12px] text-[var(--neg)]">{e}</p>
          ))}

          <div className="flex items-center gap-3">
            <button type="button" className={primaryBtn} disabled={pending} onClick={commit}>
              {pending ? "Committing…" : "We predict — commit it"}
            </button>
            <button type="button" className={ghostBtn} onClick={() => setStep("card")}>
              Back
            </button>
          </div>
        </section>
      )}

      {step === "done" && committed && (
        <section className="flex flex-col gap-4">
          <h1 className="text-[20px] font-semibold text-[var(--text)]">
            On the record. Causent measures it on {committed.resolutionDate}.
          </h1>
          <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
              Committed prediction
            </p>
            <p className="text-[16px] font-semibold text-[var(--text)]">{committed.title}</p>
            <p className="text-[14px] text-[var(--text)]">
              We predict{" "}
              <span className="font-semibold">{committed.metricName}</span> moves{" "}
              <span className={committed.direction === "POSITIVE" ? "text-[var(--pos)]" : "text-[var(--neg)]"}>
                {committed.direction === "POSITIVE" ? "up" : "down"}
              </span>{" "}
              by{" "}
              <span className="font-semibold tabular-nums">
                {committed.magnitudePct}%
              </span>{" "}
              of its mean.
            </p>
            <p className="text-[13px] text-[var(--text-muted)] tabular-nums">
              {daysToResolution !== null
                ? daysToResolution === 0
                  ? "Resolves today."
                  : `Resolves in ${daysToResolution} day${daysToResolution === 1 ? "" : "s"} — ${committed.resolutionDate}.`
                : `Resolves ${committed.resolutionDate}.`}
            </p>
            <p className="rounded border border-dashed border-[var(--border)] p-2 text-[12px] text-[var(--text-muted)]">
              Unattributed — no work item carries this mechanism yet. Arm the
              drift watch below so Causent can warn you the moment the work drifts
              from this prediction.
            </p>
          </div>

          <LeverCreate
            decisionId={committed.decisionId}
            metricId={committed.metricId}
            title={committed.title}
            mechanismSummary={committed.mechanismSummary}
            mechanismCategory={committed.mechanismCategory}
          />
          <div className="flex items-center gap-3">
            <Link href="/actions" className={primaryBtn}>
              Open the decision log
            </Link>
            <button
              type="button"
              className={ghostBtn}
              onClick={() => {
                setPaste("");
                setCard(null);
                setDeclared(null);
                setCommitted(null);
                setMagnitude("");
                setResolutionDate("");
                setErrors([]);
                setStep("paste");
              }}
            >
              Predict another decision
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
