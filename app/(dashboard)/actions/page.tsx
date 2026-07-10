import { loadDashboardData } from "@/lib/data/dashboard";
import { ActionsPageClient } from "@/components/actions/ActionsPageClient";

// Server page: reads actions + metrics from lib/data (Supabase, seed fallback) and
// hands them to the client child, which owns the click-to-select interactivity.

export default async function ActionsPage() {
  const { actions, metrics, objective } = await loadDashboardData();
  return (
    <ActionsPageClient actions={actions} metrics={metrics} objective={objective} />
  );
}
