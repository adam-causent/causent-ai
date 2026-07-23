import Link from "next/link";
import { loadDashboardData } from "@/lib/data/dashboard";
import { Panel } from "@/components/ui/Panel";
import { ConnectedMetrics } from "@/components/data-workshop/ConnectedMetrics";
import { WorkspaceMetricCatalog } from "@/components/data-workshop/WorkspaceMetricCatalog";
import { WorkspaceMetricCsvDropzone } from "@/components/data-workshop/WorkspaceMetricCsvDropzone";
import { summarizeMetricConnections } from "@/lib/data/metric-connections";
import { getSession } from "@/lib/auth/session";
import { loadReportActivationMetrics } from "@/lib/decision-reports/materialization";
import { getServerSupabase } from "@/lib/supabase-server";

// The workspace catalog is session-scoped and must never be prerendered at build time.
export const dynamic = "force-dynamic";

function ProgressRing({ value, cap }: { value: number; cap: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const filled = cap > 0 ? (value / cap) * c : 0;
  return (
    <svg width="52" height="52" viewBox="0 0 52 52">
      <circle cx="26" cy="26" r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
      <circle
        cx="26"
        cy="26"
        r={r}
        fill="none"
        stroke="var(--brand-teal)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(-90 26 26)"
      />
      <text
        x="26"
        y="26"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-[var(--text)] text-[12px] font-semibold"
      >
        {value}/{cap}
      </text>
    </svg>
  );
}

export default async function DataWorkshopPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const params = await searchParams;
  const requestedReturn = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = requestedReturn && /^\/onboarding\?report=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedReturn)
    ? requestedReturn
    : null;
  const [{ metrics, activeDecisionReport }, session, sb] = await Promise.all([
    loadDashboardData(),
    getSession(),
    getServerSupabase(),
  ]);
  const workspaceMetrics = await loadReportActivationMetrics(sb, session.workspaceId).catch(() => []);
  const removableMetricIdByName = Object.fromEntries(
    workspaceMetrics.filter((metric) => metric.isCore).map((metric) => [metric.name, metric.metricId]),
  );
  const lockedMetricName = workspaceMetrics.find(
    (metric) => metric.metricId === activeDecisionReport?.metricId && !metric.isCore,
  )?.name ?? null;
  const metricConnections = activeDecisionReport
    ? {
        connected: metrics.filter((metric) => metric.series.length > 0).length,
        total: metrics.length,
      }
    : summarizeMetricConnections(metrics.length);

  return (
    <div className="mx-auto flex max-w-[1360px] flex-col gap-4 p-5">
      {returnTo ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3">
          <div>
            <p className="text-[12px] font-semibold text-teal-950">Decision Report metric handoff</p>
            <p className="mt-0.5 text-[11px] leading-5 text-teal-900/75">
              Review the workspace metrics here, then return to confirm one against the report.
            </p>
          </div>
          <Link href={returnTo} className="rounded-lg bg-teal-900 px-3 py-2 text-[11px] font-semibold text-white">
            Return to Decision Report
          </Link>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Panel>
            <WorkspaceMetricCsvDropzone
              activeMetricName={activeDecisionReport?.metricProjection.metricName ?? null}
            />
          </Panel>
          <Panel>
            {activeDecisionReport ? (
              <>
                <ConnectedMetrics metrics={metrics} connectionSummary={metricConnections} removableMetricIdByName={removableMetricIdByName} lockedMetricName={lockedMetricName} />
                <div className="mt-5 border-t border-[var(--border)] pt-5">
                  <WorkspaceMetricCatalog
                    metrics={workspaceMetrics}
                    activeMetricId={activeDecisionReport.metricId}
                  />
                </div>
              </>
            ) : (
              <>
                <ConnectedMetrics metrics={metrics} connectionSummary={metricConnections} removableMetricIdByName={removableMetricIdByName} lockedMetricName={lockedMetricName} />
                <div className="mt-5 border-t border-[var(--border)] pt-5">
                  <WorkspaceMetricCatalog
                    metrics={workspaceMetrics}
                  />
                </div>
              </>
            )}
          </Panel>
        </div>

        {/* summary */}
        <Panel className="h-fit">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-[14px] font-semibold text-[var(--text)]">
              Core Metrics Summary
            </h3>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-[28px] font-bold tabular-nums text-[var(--text)]">
                {metricConnections.connected}
              </span>
              <span className="text-[13px] text-[var(--text-muted)]">
                /{metricConnections.total} metrics connected
              </span>
            </div>
          </div>
          <ProgressRing value={metricConnections.connected} cap={metricConnections.total} />
        </div>

        <div className="mt-4 space-y-2.5 border-t border-[var(--border)] pt-4">
          {metrics.map((m) => (
            <div key={m.id} className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span
                  className="h-2.5 w-4 rounded-full"
                  style={{ background: m.color }}
                  aria-hidden="true"
                />
                <span className="text-[13px] text-[var(--text)]">{m.name}</span>
              </div>
              <span className="text-[12px] text-[var(--text-muted)]">{m.cadence}</span>
            </div>
          ))}
          {metrics.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">
              The report metric has not been connected to a supported daily series yet.
            </p>
          ) : null}
        </div>

        </Panel>
      </div>
    </div>
  );
}
