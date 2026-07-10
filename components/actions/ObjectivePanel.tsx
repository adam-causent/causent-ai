import type { ProjectObjective } from "@/lib/types";
import { Panel } from "@/components/ui/Panel";

// The north-star document pinned above the action list: the single purpose the
// whole project is working toward. It frames the "what" (the actions below) with
// the "why", so the list reads as bets against a stated goal — not a bare log.
export function ObjectivePanel({ objective }: { objective: ProjectObjective }) {
  return (
    <Panel>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--brand-blue)]">
            {objective.title}
          </div>
          <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-[var(--text)]">
            {objective.statement}
          </p>
          <div className="mt-2 text-[11px] text-[var(--text-subtle)]">
            Updated {objective.updatedAt}
          </div>
        </div>

        <div className="shrink-0 border-t border-[var(--border)] pt-3 md:w-[320px] md:border-l md:border-t-0 md:pl-5 md:pt-0">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Key Results
          </div>
          <ul className="space-y-2">
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
        </div>
      </div>
    </Panel>
  );
}
