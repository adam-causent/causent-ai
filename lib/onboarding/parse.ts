// Pure decision-card parsing layer for the onboarding funnel (C2/#15).
//
// The LLM call lives in llm.ts; THIS module is everything deterministic around
// it: the paste guard, the strict mapping/clamping of a model response onto a
// DecisionCard, and the fallback card derivation (title = first line, metric =
// manual entry) used whenever the paste is garbage or the model is
// unavailable/unusable. The funnel never dead-ends: every path through here
// returns a workable card.
//
// Elicit-not-assert: a card carries NO magnitude, NO direction, NO suggested
// number — only structure (title, metric NAME, mechanism) and the 2-3
// interrogation questions. The team's number is typed by the team in Step 4.

export type DecisionCard = {
  /** Draft decision title, editable in Step 3. */
  title: string;
  /** The implied primary metric NAME (not an id) — null = manual metric entry. */
  metricName: string | null;
  /** One of MECHANISM_CATEGORIES. */
  mechanismCategory: string;
  /** The card's draft "what changes and why it moves the metric" (editable). */
  mechanismSummary: string;
  /** 2-3 pointed interrogation questions that refuse vagueness. */
  questions: string[];
  /** Where the card came from — surfaced in the UI so a fallback is honest. */
  source: "llm" | "fallback";
};

export const MECHANISM_CATEGORIES = [
  "activation",
  "monetization",
  "retention",
  "other",
] as const;

export const TITLE_MAX = 120;
const QUESTIONS_MIN = 2;
const QUESTIONS_MAX = 3;

/** The deterministic interrogation set (also pads a thin model response). */
export const FALLBACK_QUESTIONS = [
  "What exactly changes for the user — which screen, flow, or rule?",
  "Why would that change move this metric, mechanically? Name the causal step.",
  "What would have to be true for this to do nothing at all?",
];

/** A paste too thin to structure: empty, whitespace, or no letters at all. */
export function pasteLooksEmpty(paste: string): boolean {
  const trimmed = paste.trim();
  return trimmed.length < 12 || !/[a-zA-Z]/.test(trimmed);
}

function clampTitle(raw: string): string {
  const oneLine = raw.trim().replace(/\s+/g, " ");
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine;
}

function normalizeQuestions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const qs = raw
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .map((q) => q.trim())
    .slice(0, QUESTIONS_MAX);
  for (const fallback of FALLBACK_QUESTIONS) {
    if (qs.length >= QUESTIONS_MIN) break;
    if (!qs.includes(fallback)) qs.push(fallback);
  }
  return qs.length >= QUESTIONS_MIN ? qs : null;
}

/**
 * Map a model response onto a DecisionCard, or null when it is unusable
 * (caller falls back). Strict on shape, forgiving on volume: questions are
 * clamped to 2-3 (padded from FALLBACK_QUESTIONS), the title to one line of
 * TITLE_MAX chars, and the mechanism category onto the known set.
 */
export function mapCardResponse(raw: unknown): DecisionCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.title !== "string" || r.title.trim().length < 3) return null;
  const title = clampTitle(r.title);

  const metricName =
    typeof r.metric_name === "string" && r.metric_name.trim().length > 0
      ? r.metric_name.trim()
      : null;

  const mechanismCategory = MECHANISM_CATEGORIES.includes(
    r.mechanism_category as (typeof MECHANISM_CATEGORIES)[number],
  )
    ? (r.mechanism_category as string)
    : "other";

  const mechanismSummary =
    typeof r.mechanism_summary === "string" ? r.mechanism_summary.trim() : "";

  const questions = normalizeQuestions(r.questions);
  if (questions === null) return null;

  return { title, metricName, mechanismCategory, mechanismSummary, questions, source: "llm" };
}

/**
 * The deterministic fallback card: title = the paste's first non-empty line
 * (clamped), metric = manual entry (null), the standard interrogation set.
 * Used for garbage pastes and whenever the LLM seam is unavailable — the
 * funnel continues instead of dead-ending.
 */
export function fallbackCard(paste: string): DecisionCard {
  const firstLine =
    paste
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return {
    title: clampTitle(firstLine) || "Untitled decision",
    metricName: null,
    mechanismCategory: "other",
    mechanismSummary: "",
    questions: [...FALLBACK_QUESTIONS],
    source: "fallback",
  };
}
