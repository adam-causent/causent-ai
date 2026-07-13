// Live LLM drafter for the create-from-decision ticket copy (#16, Step 6).
//
// Mirrors lib/onboarding/llm.ts + lib/summary/live-polish.ts: raw fetch against
// the Anthropic Messages API (no SDK), strict JSON-schema output, and FAIL-SAFE
// by construction — a missing key, HTTP error, or unusable response falls back to
// a deterministic template built from the decision itself, so Step 6 never
// dead-ends on the model. Server-side only.
//
// Elicit-not-assert: the drafted ticket describes the WORK (what to build), never
// a magnitude/prediction — the team already committed the number in Step 4. The
// prompt forbids inventing outcomes or numbers.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = [
  "You turn a product team's committed decision into a short, concrete engineering",
  "ticket that a developer could pick up. Output a crisp imperative title (<=100",
  "chars) of the work to build, and a 2-4 sentence body describing WHAT to build and",
  "the mechanism (what changes for the user). Use only what the decision states.",
  "NEVER invent or mention a metric target, magnitude, percentage, direction, or",
  "timeline — the ticket is about the work, not the bet. No numbers in the body.",
].join(" ");

export type TicketCopy = { title: string; body: string };

export type DecisionSummary = {
  title: string;
  mechanismSummary: string;
  mechanismCategory?: string | null;
};

/** Deterministic fallback: the decision's own title + mechanism as the ticket. */
export function fallbackTicket(decision: DecisionSummary): TicketCopy {
  const title = decision.title.trim().slice(0, 100) || "Ship the decision's lever";
  const body =
    decision.mechanismSummary.trim() ||
    "Implement the change described in this decision. This ticket is the lever Causent watches for drift.";
  return { title, body };
}

type DraftOpts = { apiKey?: string; fetchImpl?: typeof fetch };

/** Draft ticket copy from a decision. Fail-safe to fallbackTicket on any trouble. */
export async function draftTicketCopy(
  decision: DecisionSummary,
  opts: DraftOpts = {},
): Promise<TicketCopy> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !decision.title.trim()) return fallbackTicket(decision);
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
        max_tokens: 8000,
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
                body: { type: "string" },
              },
              required: ["title", "body"],
            },
          },
        },
        messages: [
          {
            role: "user",
            content: [
              `Decision: ${decision.title}`,
              decision.mechanismSummary ? `Mechanism: ${decision.mechanismSummary}` : "",
              decision.mechanismCategory ? `Category: ${decision.mechanismCategory}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      }),
    });
    if (!res.ok) return fallbackTicket(decision);
    const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const parsed = JSON.parse(text) as { title?: unknown; body?: unknown };
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 100) : "";
    const bodyText = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!title || !bodyText) return fallbackTicket(decision);
    return { title, body: bodyText };
  } catch {
    return fallbackTicket(decision);
  }
}
