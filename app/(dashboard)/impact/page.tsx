import { loadDashboardData } from "@/lib/data/dashboard";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { AggregatedImpact } from "@/components/impact/AggregatedImpact";
import { ActionsTable } from "@/components/impact/ActionsTable";
import { TrustCaveat } from "@/components/impact/TrustCaveat";
import { ImpactBar } from "@/components/charts/ImpactBar";

export default async function ImpactPage() {
  const { actions, aggregatedImpact, impactByMetric, metrics, activeDecisionReport } =
    await loadDashboardData();

  return (
    <div className="mx-auto max-w-[1360px] space-y-4 p-5">
      {activeDecisionReport ? (
        <div className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3">
          <p className="text-[12px] font-semibold text-teal-950">{activeDecisionReport.title}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-teal-900/75">
            Impact is isolated to this report&apos;s selected actions and confirmed metric. Planned work has no causal claim until it ships and accumulates enough history.
          </p>
        </div>
      ) : null}
      <AggregatedImpact
        stats={aggregatedImpact}
        impactByMetric={impactByMetric}
        metrics={metrics}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Impact by Metric"
            subtitle="Net confident causal lift (ITS, all history)"
          />
          <div className="mb-4">
            <TrustCaveat />
          </div>
          <ImpactBar rows={impactByMetric} metrics={metrics} />
        </Panel>

        <Panel>
          <PanelHeader title="Actions" />
          <ActionsTable actions={actions} metrics={metrics} />
        </Panel>
      </div>
    </div>
  );
}
