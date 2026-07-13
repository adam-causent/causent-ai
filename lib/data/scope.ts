// getScope() — the org -> project -> workspace names for the demo workspace, mapped
// from Supabase to lib/types.ts Scope. Mirrors the lib/seed.ts `scope` export.

import type { Scope } from "@/lib/types";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID } from "@/lib/data/config";

type WorkspaceRow = {
  name: string;
  projects: { name: string; orgs: { name: string } | null } | null;
};

/** The demo scope's display names (org / project / workspace). */
export async function getScope(): Promise<Scope> {
  const sb = await getServerSupabase();
  const res = await sb
    .from("workspaces")
    .select("name, projects(name, orgs(name))")
    .eq("workspace_id", DEMO_SCOPE_ID)
    .single();
  if (res.error) throw res.error;

  const row = res.data as unknown as WorkspaceRow;
  return {
    org: row.projects?.orgs?.name ?? "",
    project: row.projects?.name ?? "",
    workspace: row.name,
  };
}
