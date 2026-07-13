"use client";

// Steps 5-6 of the cold-start funnel (#16): the earned connector ask, then
// create-the-lever-ticket-FROM-the-decision. Read-only default: Causent drafts
// the ticket + a prefilled deep-link; the user creates it in THEIR repo (no write
// scope). Detection then attributes the prediction — proven end-to-end locally by
// the paste-URL fallback (no GitHub credentials needed).
//
// Framed as consequence: skipping keeps the prediction but loses drift.

import { useState, useTransition } from "react";
import {
  attributeLeverByUrl,
  draftLeverForDecision,
} from "@/app/(onboarding)/onboarding/server-actions";

type Props = {
  decisionId: string;
  metricId: string;
  title: string;
  mechanismSummary: string;
  mechanismCategory?: string | null;
};

type Phase = "connect" | "create" | "attributed";

const primaryBtn =
  "rounded bg-[var(--text)] px-4 py-2 text-[14px] font-medium text-[var(--surface)] disabled:opacity-40";
const ghostBtn =
  "rounded border border-[var(--border)] px-4 py-2 text-[14px] text-[var(--text-muted)] hover:text-[var(--text)]";
const field =
  "rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--text)]";

export function LeverCreate(props: Props) {
  const [phase, setPhase] = useState<Phase>("connect");
  const [repo, setRepo] = useState("");
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [issueUrl, setIssueUrl] = useState("");
  const [externalRef, setExternalRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function connectAndDraft() {
    setError(null);
    startTransition(async () => {
      const res = await draftLeverForDecision({
        decisionId: props.decisionId,
        metricId: props.metricId,
        repo: repo.trim(),
        title: props.title,
        mechanismSummary: props.mechanismSummary,
        mechanismCategory: props.mechanismCategory,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDeepLink(res.deepLink);
      setToken(res.token);
      setPhase("create");
    });
  }

  function attribute() {
    if (!token) return;
    setError(null);
    startTransition(async () => {
      const res = await attributeLeverByUrl({ token, url: issueUrl.trim() });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setExternalRef(res.externalRef);
      setPhase("attributed");
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
        Arm the drift watch
      </p>

      {phase === "connect" && (
        <>
          <h2 className="text-[16px] font-semibold text-[var(--text)]">
            Anchor this prediction to the work that will move it.
          </h2>
          <p className="text-[13px] text-[var(--text-muted)]">
            Connect the repo you ship from (read + webhooks). Causent drafts the
            lever ticket from your decision and watches it — so the moment the
            work drifts from this prediction, you hear about it. Skip and you keep
            the prediction, but lose the drift alert.
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--text-muted)]">
              Watch target (owner/repo)
            </span>
            <input
              className={field}
              placeholder="acme/orbit"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
          {error && <p className="text-[13px] text-[var(--neg)]">{error}</p>}
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={primaryBtn}
              disabled={pending || !repo.trim()}
              onClick={connectAndDraft}
            >
              {pending ? "Drafting…" : "Connect & draft the lever ticket"}
            </button>
          </div>
        </>
      )}

      {phase === "create" && deepLink && (
        <>
          <h2 className="text-[16px] font-semibold text-[var(--text)]">
            Create the lever ticket in GitHub.
          </h2>
          <p className="text-[13px] text-[var(--text-muted)]">
            We prefilled the title, body, and a{" "}
            <code className="rounded bg-[var(--bg)] px-1 text-[12px]">{token}</code>{" "}
            label that carries the provenance. Create it in your repo — Causent
            never needs write access.
          </p>
          <div className="flex items-center gap-3">
            <a
              className={primaryBtn}
              href={deepLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              Create in GitHub ↗
            </a>
          </div>

          <div className="mt-2 border-t border-dashed border-[var(--border)] pt-3">
            <p className="text-[13px] font-medium text-[var(--text)]">
              Already created it? Paste the issue URL.
            </p>
            <p className="text-[12px] text-[var(--text-muted)]">
              The webhook attributes it automatically once the GitHub App is
              connected; this is the manual fallback.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                className={`${field} flex-1`}
                placeholder="https://github.com/acme/orbit/issues/42"
                value={issueUrl}
                onChange={(e) => setIssueUrl(e.target.value)}
              />
              <button
                type="button"
                className={ghostBtn}
                disabled={pending || !issueUrl.trim()}
                onClick={attribute}
              >
                {pending ? "Attributing…" : "Attribute"}
              </button>
            </div>
          </div>
          {error && <p className="text-[13px] text-[var(--neg)]">{error}</p>}
        </>
      )}

      {phase === "attributed" && (
        <>
          <h2 className="text-[16px] font-semibold text-[var(--pos)]">
            Attributed — the lever is live.
          </h2>
          <p className="text-[13px] text-[var(--text)]">
            This prediction is anchored to{" "}
            <span className="font-semibold tabular-nums">{externalRef}</span>.
            Causent is watching that ticket; if it drifts from your prediction,
            you’ll get an alert. The prediction is no longer unattributed.
          </p>
        </>
      )}
    </section>
  );
}
