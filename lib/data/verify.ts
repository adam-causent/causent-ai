// Integration checks for the Supabase-backed data layer. Asserts the DB-to-UI mapping
// against the seeded demo tenant (engine/persistence/seed_demo.py). Server-only.
//
// Run against a live local Supabase after seeding:
//   cd engine && .venv/bin/python persistence/seed_demo.py   # seed the demo tenant
//   node --experimental-strip-types --env-file=.env.local \
//     -e "import('./lib/data/verify.ts').then(m=>m.verifyDataLayer()).then(console.log)"
// (Node resolves relative paths, not the @/* alias; a small runner is used above.)
//
// verifyDataLayer() returns the collected assertions; it throws on the first failure.

import { getScope } from "@/lib/data/scope";
import { getMetrics } from "@/lib/data/metrics";
import { getActions } from "@/lib/data/actions";
import { getImpactByMetric, getAggregatedImpact } from "@/lib/data/impact";
import { METRIC_ORDER } from "@/lib/data/config";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`data-layer check failed: ${msg}`);
}

export async function verifyDataLayer(): Promise<string[]> {
  const checks: string[] = [];
  const ok = (msg: string) => checks.push(`ok: ${msg}`);

  // --- Scope ---------------------------------------------------------------
  const scope = await getScope();
  assert(scope.org === "Causent", `scope.org == Causent (got ${scope.org})`);
  assert(scope.project === "Orbit", `scope.project == Orbit (got ${scope.project})`);
  assert(
    scope.workspace === "Gummy Alpha",
    `scope.workspace == Gummy Alpha (got ${scope.workspace})`,
  );
  ok("scope maps to Causent / Orbit / Gummy Alpha");

  // --- Metrics -------------------------------------------------------------
  const metrics = await getMetrics();
  assert(metrics.length === 5, `5 metrics (got ${metrics.length})`);
  assert(
    metrics.map((m) => m.id).join(",") === METRIC_ORDER.join(","),
    "metrics in canonical order",
  );
  const arr = metrics.find((m) => m.id === "arr")!;
  assert(arr.format === "currency" && arr.higherIsBetter, "ARR = currency, higherIsBetter");
  const churn = metrics.find((m) => m.id === "churn")!;
  assert(!churn.higherIsBetter, "churn is inverted (higherIsBetter false)");
  assert(metrics.every((m) => m.series.length === 210), "each metric has 210 daily points");
  assert(
    metrics.every((m) => m.series.every((p, i, s) => i === 0 || p.date > s[i - 1].date)),
    "each series is strictly ascending by date",
  );
  ok("5 metrics, 210 daily points each, correct format/inversion");

  // --- Actions + honest impact cells --------------------------------------
  const actions = await getActions();
  assert(actions.length === 10, `10 actions (got ${actions.length})`);
  assert(
    actions.every((a, i, s) => i === 0 || a.shippedAt <= s[i - 1].shippedAt),
    "actions ordered newest ship date first",
  );
  assert(
    actions.every((a) => a.impact.length === 5),
    "every action has an impact cell per metric",
  );

  // Confident landmark: PR #8107 -> ARR is +$ POSITIVE (belief 1.0).
  const pr8107 = actions.find((a) => a.pr === 8107)!;
  const arrCell = pr8107.impact.find((c) => c.metricId === "arr")!;
  assert(arrCell.direction === "up" && arrCell.good, "PR#8107 ARR cell is up/good");
  assert(
    arrCell.value !== null && arrCell.value > 200_000 && arrCell.label.startsWith("+$"),
    `PR#8107 ARR cell shows a real +$ lift (got ${arrCell.label})`,
  );
  // Confident but BAD: PR #8107 -> Gross Profit is NEGATIVE (belief 1.0).
  const gpCell = pr8107.impact.find((c) => c.metricId === "grossProfit")!;
  assert(
    gpCell.direction === "down" && !gpCell.good && gpCell.value !== null,
    `PR#8107 Gross Profit cell is a confident down/bad number (got ${gpCell.label})`,
  );

  // Confident landmark: PR #8256 -> Activation is +pp POSITIVE.
  const pr8256 = actions.find((a) => a.pr === 8256)!;
  const actCell = pr8256.impact.find((c) => c.metricId === "activation")!;
  assert(
    actCell.direction === "up" && actCell.good && actCell.label.endsWith("pp"),
    `PR#8256 Activation cell is a confident +pp number (got ${actCell.label})`,
  );

  // Gathering-data cohort: a May PR withholds every cell as "—".
  const may = actions.find((a) => a.pr === 8421)!;
  assert(
    may.impact.every((c) => c.direction === "neutral" && c.label === "—"),
    "PR#8421 (May cohort, < 45 post days) shows all neutral — cells",
  );
  assert(pr8107.rationale !== undefined, "PR#8107 carries a rationale");
  ok("actions: confident landmarks show real ITS lifts; May cohort withholds honestly");

  // --- Impact by metric ----------------------------------------------------
  const byMetric = await getImpactByMetric();
  assert(byMetric.length === 5, "impact-by-metric has 5 rows");
  const arrImpact = byMetric.find((r) => r.metricId === "arr")!;
  assert(
    arrImpact.direction === "up" && arrImpact.value > 200_000,
    "ARR net confident impact is a strong +",
  );
  const gpImpact = byMetric.find((r) => r.metricId === "grossProfit")!;
  assert(gpImpact.direction === "down", "Gross Profit net confident impact is negative");
  const churnImpact = byMetric.find((r) => r.metricId === "churn")!;
  assert(
    churnImpact.direction === "neutral" && churnImpact.label === "—",
    "churn (no confident edge) reads neutral —",
  );
  ok("impact-by-metric reflects only confident causal claims");

  // --- Aggregated impact ---------------------------------------------------
  const agg = await getAggregatedImpact();
  const shipped = agg.find((s) => s.label === "Actions Shipped")!;
  assert(shipped.value === "10", `Actions Shipped == 10 (got ${shipped.value})`);
  const gathering = agg.find((s) => s.label === "Gathering Data")!;
  assert(Number(gathering.value) > 0, "Gathering Data count is > 0 (May cohort)");
  const confident = agg.find((s) => s.label === "Confident Readouts")!;
  assert(Number(confident.value) >= 2, "at least 2 confident readouts");
  ok("aggregated impact cards computed from the graph");

  return checks;
}
