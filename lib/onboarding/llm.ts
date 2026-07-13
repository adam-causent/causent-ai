// Live LLM decision-card parser for the onboarding funnel (C2/#15).
//
// Mirrors lib/summary/live-polish.ts: raw fetch against the Anthropic Messages
// API (no SDK runtime dependency), strict JSON schema output, and FAIL-SAFE by
// construction — on a missing key, network error, or unusable response it
// returns the deterministic fallback card (parse.ts) so the funnel never
// dead-ends on the model. Server-side only: the key never reaches the client
// (the funnel calls this through a server action).
//
// Elicit-not-assert: the system prompt forbids suggesting any magnitude or
// direction — the card structures the decision; the TEAM commits the number.

import {
  fallbackCard,
  mapCardResponse,
  pasteLooksEmpty,
  type DecisionCard,
} from "./parse.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Default model for new AI calls (matches lib/summary/live-polish.ts).
const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = [
  "You structure a product team's pasted note (a doc, Slack thread, or ticket) into a",
  "draft decision card for a decision-intelligence tool. Extract: a crisp one-line title",
  "of what they are about to build; the single primary business metric they expect it to",
  "change, as a short metric NAME (metric_name — null if none is stated or clearly implied,",
  "never invent one); the mechanism category (activation, monetization, retention, or",
  "other); and a 1-2 sentence mechanism_summary of what changes and why that would move",
  "the metric, using only what the paste actually says.",
  "Then ask 2-3 pointed interrogation questions that refuse vagueness: each must press on",
  "something the paste left unstated — the concrete user-facing change, the causal step",
  "from change to metric, or what would falsify the bet. No softballs.",
  "NEVER suggest, estimate, or imply a magnitude, percentage, direction, or timeline —",
  "the team commits their own number later. Questions must not contain numbers.",
].join(" ");

type ParseOpts = {
  apiKey?: string;
  /** Override for tests; defaults to the real Anthropic endpoint. */
  fetchImpl?: typeof fetch;
};

const PASTE_MAX_CHARS = 20_000; // input cap, mirrors the engine-fn guard ethos

/**
 * Parse a paste into a DecisionCard through the live model. Fail-safe: any
 * problem — thin paste, missing key, HTTP error, schema mismatch — returns
 * fallbackCard(paste) and the funnel continues on the manual path.
 */
export async function parsePasteWithLLM(
  paste: string,
  opts: ParseOpts = {},
): Promise<DecisionCard> {
  if (pasteLooksEmpty(paste)) return fallbackCard(paste);
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackCard(paste);
  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const res = await doFetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                metric_name: { type: ["string", "null"] },
                mechanism_category: {
                  type: "string",
                  enum: ["activation", "monetization", "retention", "other"],
                },
                mechanism_summary: { type: "string" },
                // 2-3 enforced by the prompt + clamped/padded in mapCardResponse
                // (the API rejects minItems > 1, so the schema stays loose).
                questions: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: [
                "title",
                "metric_name",
                "mechanism_category",
                "mechanism_summary",
                "questions",
              ],
            },
          },
        },
        messages: [{ role: "user", content: paste.slice(0, PASTE_MAX_CHARS) }],
      }),
    });
    if (!res.ok) return fallbackCard(paste);
    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    return mapCardResponse(JSON.parse(text)) ?? fallbackCard(paste);
  } catch {
    return fallbackCard(paste); // fail-safe: the funnel never dead-ends here
  }
}
