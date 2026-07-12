// getPriorsForReferenceClass() — the RLS-scoped reference-class query behind
// the prediction-capture precedent panel (epic #6, child #9). The math lives
// in the PURE lib/priors.ts (unit-tested without a DB); this wrapper only
// fetches the terminally-resolved tuples and narrows the class.

import {
  computePriors,
  fromStoredTuple,
  type ReferenceClassPriors,
  type ResolutionTuple,
} from "@/lib/priors";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEMO_SCOPE_ID } from "@/lib/data/config";

/**
 * Priors for a reference class. The class is (metric) narrowed by mechanism
 * category when one is given; only TERMINALLY resolved predictions contribute
 * (GATHERING is a not-yet, not an outcome — resolved_at stays NULL).
 */
export async function getPriorsForReferenceClass(params: {
  metricId: string;
  mechanismCategory?: string | null;
}): Promise<ReferenceClassPriors> {
  const sb = await getServerSupabase();
  const res = await sb
    .from("predictions")
    .select("resolved_verdict, resolution_tuple")
    .eq("scope_id", DEMO_SCOPE_ID)
    .eq("metric_id", params.metricId)
    .not("resolved_at", "is", null);
  if (res.error) throw res.error;

  let tuples = (res.data as Parameters<typeof fromStoredTuple>[0][])
    .map(fromStoredTuple)
    .filter((t): t is ResolutionTuple => t !== null);
  if (params.mechanismCategory) {
    tuples = tuples.filter((t) => t.mechanismCategory === params.mechanismCategory);
  }
  return computePriors(tuples);
}
