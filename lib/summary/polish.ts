// Optional LLM "polish" seam for the summary layer.
//
// The deterministic core (generate.ts) is the source of truth. Polishing may ONLY
// rephrase surface prose; it can never change what the numbers say. This module
// is OFF by default (noopPolisher) and, when a real polisher is wired in, every
// trust-critical field is re-asserted from the deterministic draft after polish —
// so a hallucinating or adversarial model can never upgrade or invent a claim.
//
// No live model is called here. A production polisher would implement
// SummaryPolisher against the Anthropic API behind this same interface.

import { generateSummary } from "./generate.ts";
import { ESTIMATED_NOT_PROVEN, METHOD_LABEL, type ReadoutRow, type Summary } from "./types.ts";

/** The seam. Implementations rephrase `draft.headline` / `draft.detail` only. */
export interface SummaryPolisher {
  polish(input: { row: ReadoutRow; draft: Summary }): Promise<Summary>;
}

/** Default: no polish. The deterministic draft is returned untouched. */
export const noopPolisher: SummaryPolisher = {
  async polish({ draft }) {
    return draft;
  },
};

/** Re-assert every trust-critical field from the deterministic draft, and drop a
 *  polished directional headline that silently lost the "estimated, not proven"
 *  lead. Prose may change; the verdict may not. */
export function enforceInvariants(draft: Summary, polished: Summary): Summary {
  const directional = draft.claimStrength === "confident" || draft.claimStrength === "tentative";
  const headline =
    directional && !polished.headline.toLowerCase().includes(ESTIMATED_NOT_PROVEN.toLowerCase())
      ? draft.headline // polisher stripped the honest lead — fall back to the core
      : polished.headline;

  return {
    headline,
    detail: polished.detail,
    // Everything below is load-bearing for trust and is NEVER taken from the polisher.
    caveat: draft.caveat,
    method: METHOD_LABEL,
    claimStrength: draft.claimStrength,
    gatheringData: draft.gatheringData,
    disagreement: draft.disagreement,
  };
}

/** Generate a summary, optionally routing the draft through a polisher. The
 *  polisher is invariant-clamped, so the honest verdict is identical either way. */
export async function generateSummaryWithPolish(
  row: ReadoutRow,
  polisher: SummaryPolisher = noopPolisher,
): Promise<Summary> {
  const draft = generateSummary(row);
  const polished = await polisher.polish({ row, draft });
  return enforceInvariants(draft, polished);
}
