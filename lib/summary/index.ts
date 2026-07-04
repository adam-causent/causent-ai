// Honest-summary layer (Phase B1). Deterministic templating over a readout row,
// with an optional (off-by-default) LLM polish seam. See generate.ts for the rules.

export {
  FLOOR_CONFIDENT,
  METHOD_LABEL,
  ESTIMATED_NOT_PROVEN,
  type BeliefDirection,
  type BeliefReason,
  type ReadoutStatus,
  type ItsReadout,
  type NaiveReadout,
  type Belief,
  type ActionContext,
  type MetricContext,
  type ReadoutRow,
  type ClaimStrength,
  type Summary,
} from "./types.ts";

export { generateSummary, resolveStrength, formatDelta } from "./generate.ts";

export {
  generateSummaryWithPolish,
  enforceInvariants,
  noopPolisher,
  type SummaryPolisher,
} from "./polish.ts";
