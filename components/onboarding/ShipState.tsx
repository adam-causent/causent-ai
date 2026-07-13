import Link from "next/link";

// Ship state — the Step-7 confirmation (C5/#18). After the prediction is
// committed and the lever ticket is created/watched, the funnel goes quiet:
// this screen restates the committed prediction, shows the lever ticket(s) it's
// watching + the due date, and hands control back with one calm, trust-first
// line. Reuses the design system; no new chrome.
//
// Trust caveat LEADS: the promise is restraint ("I'll interrupt you only if the
// work stops matching your intent"), not noise.

export type WatchedLever = {
  /** External ref, e.g. "PR #42" / "issue #42". */
  ref: string;
  /** The issue URL, when known (deep-link or pasted). */
  url?: string | null;
  /** Lifecycle status: DRAFTED / CREATED / DETECTED / SHIPPED. */
  status?: string | null;
};

const cardCls =
  "flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";
const kicker =
  "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]";

export function ShipState({
  title,
  metricName,
  direction,
  magnitudePct,
  resolutionDate,
  levers,
}: {
  title: string;
  metricName: string;
  direction: "POSITIVE" | "NEGATIVE";
  magnitudePct: number;
  resolutionDate: string;
  levers: WatchedLever[];
}) {
  const up = direction === "POSITIVE";
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-[20px] font-semibold text-[var(--text)]">
        You&apos;re set. Go build.
      </h1>

      {/* The committed prediction, restated. */}
      <div className={cardCls}>
        <span className={kicker}>Committed prediction</span>
        <p className="text-[16px] font-semibold text-[var(--text)]">{title}</p>
        <p className="text-[14px] text-[var(--text)]">
          We predict{" "}
          <span className="font-semibold">{metricName}</span> moves{" "}
          <span className={up ? "text-[var(--pos)]" : "text-[var(--neg)]"}>
            {up ? "up" : "down"}
          </span>{" "}
          by{" "}
          <span className="font-semibold tabular-nums">{magnitudePct}%</span> of its mean.
        </p>
        <p className="text-[13px] text-[var(--text-muted)] tabular-nums">
          Resolves {resolutionDate}.
        </p>
      </div>

      {/* The lever ticket(s) Causent is watching. */}
      <div className={cardCls}>
        <span className={kicker}>
          {levers.length > 0 ? "Watching" : "No lever watched yet"}
        </span>
        {levers.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {levers.map((lv) => (
              <li key={lv.ref} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[14px] text-[var(--text)]">
                  <span aria-hidden="true">🎯</span>
                  {lv.url ? (
                    <a
                      href={lv.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tabular-nums underline decoration-dotted underline-offset-2 hover:text-[var(--brand-teal)]"
                    >
                      {lv.ref}
                    </a>
                  ) : (
                    <span className="tabular-nums">{lv.ref}</span>
                  )}
                </span>
                {lv.status && (
                  <span className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
                    {lv.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-[var(--text-muted)]">
            The prediction is on the record, but no work item carries its mechanism
            yet — so there&apos;s no drift watch. You can arm one any time from the
            decision log.
          </p>
        )}
      </div>

      {/* The calm, trust-first hand-off. */}
      <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-4 text-[14px] leading-relaxed text-[var(--text)]">
        Go build. I&apos;ll interrupt you only if the work stops matching your intent.
      </p>

      <div className="flex items-center gap-3">
        <Link
          href="/actions"
          className="rounded bg-[var(--text)] px-4 py-2 text-[14px] font-medium text-[var(--surface)]"
        >
          Open the decision log
        </Link>
      </div>
    </section>
  );
}
