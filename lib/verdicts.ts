// Presentation map for the 8-state resolution verdict machine (epic #6, #10).
// PURE module (unit-tested): components render from this single source so the
// verdict copy stays consistent and the trust caveat always leads the readout.
//
// Colorblind-safe: every verdict carries a GLYPH + LABEL; color (tone) is never
// the only channel — mirrors the Delta component's triple encoding.

import type { PredictionVerdict } from "./types";

export type VerdictTone = "positive" | "negative" | "neutral" | "plain";

export type VerdictPresentation = {
  verdict: PredictionVerdict;
  /** Short badge text. */
  label: string;
  /** The honest one-liner that LEADS the readout (trust caveat first). */
  caveat: string;
  tone: VerdictTone;
  /** Text glyph, never color-alone. */
  glyph: string;
  /** Terminal = re-resolution is a no-op; GATHERING re-measures. */
  terminal: boolean;
};

export const VERDICT_PRESENTATION: Record<PredictionVerdict, VerdictPresentation> = {
  CONFIRMED: {
    verdict: "CONFIRMED",
    label: "Confirmed",
    caveat:
      "You called it — the measured lift matched your committed direction, and the size landed inside the measurement's confidence interval.",
    tone: "positive",
    glyph: "✓",
    terminal: true,
  },
  DIRECTION_CONFIRMED: {
    verdict: "DIRECTION_CONFIRMED",
    label: "Direction confirmed",
    caveat:
      "Right way, off on size — the metric moved the way you predicted, but the measured size fell outside your committed magnitude.",
    tone: "positive",
    glyph: "≈",
    terminal: true,
  },
  REFUTED: {
    verdict: "REFUTED",
    label: "Refuted",
    caveat:
      "Moved the other way — the strongest learning a pre-registered prediction can produce.",
    tone: "negative",
    glyph: "✗",
    terminal: true,
  },
  INCONCLUSIVE: {
    verdict: "INCONCLUSIVE",
    label: "Inconclusive",
    caveat: "No confident signal — unproven, not wrong.",
    tone: "neutral",
    glyph: "?",
    terminal: true,
  },
  GATHERING: {
    verdict: "GATHERING",
    label: "Gathering data",
    caveat:
      "Not yet — the engine needs more daily history before an honest readout. The resolution date auto-extended; a not-yet is not a no.",
    tone: "plain",
    glyph: "⧗",
    terminal: false,
  },
  UNRESOLVABLE: {
    verdict: "UNRESOLVABLE",
    label: "Unresolvable",
    caveat: "This metric can't be measured cleanly here (degenerate fit).",
    tone: "neutral",
    glyph: "⊘",
    terminal: true,
  },
  VOIDED: {
    verdict: "VOIDED",
    label: "Voided",
    caveat: "The lever never shipped — there is nothing to measure.",
    tone: "neutral",
    glyph: "–",
    terminal: true,
  },
  UNATTRIBUTED: {
    verdict: "UNATTRIBUTED",
    label: "Unattributed",
    caveat:
      "No action is mapped as the lever, so there is nothing to measure. Map a lever before the resolution date.",
    tone: "negative",
    glyph: "!",
    terminal: true,
  },
  UNMEASURABLE_NO_METRIC: {
    verdict: "UNMEASURABLE_NO_METRIC",
    label: "No metric wired",
    caveat:
      "You declared this metric but never connected a data source, so there's nothing to measure against. Connect the metric to score it, or self-report the outcome.",
    tone: "neutral",
    glyph: "⊙",
    terminal: true,
  },
};

export const ALL_VERDICTS = Object.keys(VERDICT_PRESENTATION) as PredictionVerdict[];

export function presentVerdict(v: PredictionVerdict): VerdictPresentation {
  return VERDICT_PRESENTATION[v];
}
