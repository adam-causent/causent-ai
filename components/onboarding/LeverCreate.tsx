"use client";

// Steps 5-6 of the cold-start funnel (#16 GitHub, #19 Jira): the earned connector
// ask, then create-the-lever-ticket-FROM-the-decision. Two lanes:
//
//   * EFFICIENT (write-scope, emphasized): with a write credential configured,
//     Causent creates the ticket itself — zero clicks — and attributes the
//     prediction in one shot. Sets the provenance (GitHub label / Jira issue
//     property). This is the fast lane, surfaced first.
//   * READ-ONLY (default): Causent drafts the ticket + a prefilled deep-link; the
//     user creates it in THEIR tracker (no write scope). Detection then attributes
//     — proven end-to-end by the paste-URL fallback (no credentials needed).
//
// Framed as consequence: skipping keeps the prediction but loses drift.

import { useState, useTransition } from "react";
import {
  attributeLeverByUrl,
  autoCreateLeverForDecision,
  draftLeverForDecision,
} from "@/app/(onboarding)/onboarding/server-actions";

type Tracker = "github" | "jira";

type Props = {
  decisionId: string;
  metricId: string;
  title: string;
  mechanismSummary: string;
  mechanismCategory?: string | null;
  /** Fires when the lever is attributed — the funnel advances to ship state. */
  onAttributed?: (externalRef: string, url: string) => void;
};

type Phase = "connect" | "create" | "attributed";

const primaryBtn =
  "rounded bg-[var(--text)] px-4 py-2 text-[14px] font-medium text-[var(--surface)] disabled:opacity-40";
const ghostBtn =
  "rounded border border-[var(--border)] px-4 py-2 text-[14px] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40";
const field =
  "rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--text)]";

export function LeverCreate(props: Props) {
  const [phase, setPhase] = useState<Phase>("connect");
  const [tracker, setTracker] = useState<Tracker>("github");
  const [repo, setRepo] = useState("");
  // Jira target (site base + project key are required; the numeric ids power the
  // read-only deep-link and the write-scope create).
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraProjectKey, setJiraProjectKey] = useState("");
  const [jiraProjectId, setJiraProjectId] = useState("");
  const [jiraIssueTypeId, setJiraIssueTypeId] = useState("");

  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [issueUrl, setIssueUrl] = useState("");
  const [externalRef, setExternalRef] = useState<string | null>(null);
  const [attributedUrl, setAttributedUrl] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const targetReady =
    tracker === "github" ? repo.trim().length > 0 : jiraProjectKey.trim().length > 0;

  function targetPayload() {
    return tracker === "github"
      ? { targetSource: "github" as const, repo: repo.trim() }
      : {
          targetSource: "jira" as const,
          jira: {
            projectKey: jiraProjectKey.trim(),
            baseUrl: jiraBaseUrl.trim() || undefined,
            projectId: jiraProjectId.trim() || undefined,
            issueTypeId: jiraIssueTypeId.trim() || undefined,
          },
        };
  }

  const base = {
    decisionId: props.decisionId,
    metricId: props.metricId,
    title: props.title,
    mechanismSummary: props.mechanismSummary,
    mechanismCategory: props.mechanismCategory,
  };

  // Fast lane: try the write-scope auto-create; on writeUnavailable fall back to
  // drafting the read-only deep-link so the user is never dead-ended.
  function createAutomatically() {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await autoCreateLeverForDecision({ ...base, ...targetPayload() });
      if (res.ok) {
        setExternalRef(res.externalRef);
        setAttributedUrl(res.url);
        setPhase("attributed");
        props.onAttributed?.(res.externalRef, res.url);
        return;
      }
      if (res.writeUnavailable) {
        setNote("No write access yet — drafting a one-click create link instead.");
        await draftReadOnly();
        return;
      }
      setError(res.error);
    });
  }

  async function draftReadOnly() {
    const res = await draftLeverForDecision({ ...base, ...targetPayload() });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDeepLink(res.deepLink);
    setToken(res.token);
    setPhase("create");
  }

  function draftLink() {
    setError(null);
    setNote(null);
    startTransition(draftReadOnly);
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
      setAttributedUrl(issueUrl.trim());
      setPhase("attributed");
      props.onAttributed?.(res.externalRef, issueUrl.trim());
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
            Connect the tracker you ship from. Causent drafts the lever ticket from
            your decision and watches it — so the moment the work drifts from this
            prediction, you hear about it. Skip and you keep the prediction, but
            lose the drift alert.
          </p>

          <div className="flex gap-2">
            {(["github", "jira"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTracker(t)}
                className={`rounded px-3 py-1.5 text-[13px] font-medium ${
                  tracker === t
                    ? "bg-[var(--text)] text-[var(--surface)]"
                    : "border border-[var(--border)] text-[var(--text-muted)]"
                }`}
              >
                {t === "github" ? "GitHub" : "Jira"}
              </button>
            ))}
          </div>

          {tracker === "github" ? (
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
          ) : (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-[var(--text-muted)]">
                  Jira project key (watch target)
                </span>
                <input
                  className={field}
                  placeholder="ORB"
                  value={jiraProjectKey}
                  onChange={(e) => setJiraProjectKey(e.target.value)}
                />
              </label>
              <details className="text-[12px] text-[var(--text-muted)]">
                <summary className="cursor-pointer select-none">
                  Site + type ids (for the one-click create link)
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <input
                    className={field}
                    placeholder="https://acme.atlassian.net"
                    value={jiraBaseUrl}
                    onChange={(e) => setJiraBaseUrl(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <input
                      className={`${field} flex-1`}
                      placeholder="project id (e.g. 10001)"
                      value={jiraProjectId}
                      onChange={(e) => setJiraProjectId(e.target.value)}
                    />
                    <input
                      className={`${field} flex-1`}
                      placeholder="issue type id (e.g. 10002)"
                      value={jiraIssueTypeId}
                      onChange={(e) => setJiraIssueTypeId(e.target.value)}
                    />
                  </div>
                </div>
              </details>
            </div>
          )}

          {note && <p className="text-[13px] text-[var(--text-muted)]">{note}</p>}
          {error && <p className="text-[13px] text-[var(--neg)]">{error}</p>}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              className={primaryBtn}
              disabled={pending || !targetReady}
              onClick={createAutomatically}
            >
              {pending ? "Working…" : "⚡ Create the lever ticket for me"}
            </button>
            <button
              type="button"
              className={ghostBtn}
              disabled={pending || !targetReady}
              onClick={draftLink}
            >
              Or draft a one-click create link
            </button>
            <p className="text-[11px] text-[var(--text-subtle)]">
              The fast lane creates the ticket with a write grant. Without one, the
              link lets you create it yourself — Causent never needs write access.
            </p>
          </div>
        </>
      )}

      {phase === "create" && deepLink && (
        <>
          <h2 className="text-[16px] font-semibold text-[var(--text)]">
            Create the lever ticket in {tracker === "github" ? "GitHub" : "Jira"}.
          </h2>
          <p className="text-[13px] text-[var(--text-muted)]">
            We prefilled the title, body, and a{" "}
            <code className="rounded bg-[var(--bg)] px-1 text-[12px]">{token}</code>{" "}
            marker that carries the provenance. Create it in your project — Causent
            never needs write access.
          </p>
          <div className="flex items-center gap-3">
            <a className={primaryBtn} href={deepLink} target="_blank" rel="noopener noreferrer">
              Create in {tracker === "github" ? "GitHub" : "Jira"} ↗
            </a>
          </div>

          <div className="mt-2 border-t border-dashed border-[var(--border)] pt-3">
            <p className="text-[13px] font-medium text-[var(--text)]">
              Already created it? Paste the issue URL.
            </p>
            <p className="text-[12px] text-[var(--text-muted)]">
              The webhook attributes it automatically once the connector is live;
              this is the manual fallback.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                className={`${field} flex-1`}
                placeholder={
                  tracker === "github"
                    ? "https://github.com/acme/orbit/issues/42"
                    : "https://acme.atlassian.net/browse/ORB-42"
                }
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
            <span className="font-semibold tabular-nums">{externalRef}</span>
            {attributedUrl ? (
              <>
                {" "}
                (
                <a
                  className="underline"
                  href={attributedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  open
                </a>
                )
              </>
            ) : null}
            . Causent is watching that ticket; if it drifts from your prediction,
            you’ll get an alert. The prediction is no longer unattributed.
          </p>
        </>
      )}
    </section>
  );
}
