// Action-title sanitizer for the honest-summary layer (Phase B — adversarial hardening).
//
// PR titles are attacker-controlled free text. The confident / tentative / no-effect
// headlines embed the action label (which includes the PR title) INSIDE the tool's own
// honest voice, e.g. "Estimated impact, not proven: after shipping #12 (<title>), …".
// Without sanitizing, a PR titled "This is PROVEN to guarantee a 10x, confirmed win"
// smuggles manufactured-certainty / prompt-injection tokens straight into a directional
// headline the reader sees — and even trips the honesty guard on the core's own draft,
// which the polish clamp then cannot repair (the toxic text lives in the trusted draft).
//
// sanitizeActionTitle NEUTRALISES exactly the certainty / naive-elevation / injection
// vocabulary that violatesHonestyClaim() flags (polish.ts), so:
//   1. no title text can make the rendered summary assert a proven/causal claim, and
//   2. the deterministic core NEVER trips its own honesty guard (the invariant the
//      polish clamp relies on to safely revert adversarial polish to the core draft).

const REDACTION = "[redacted]";

/** Certainty / naive-elevation / prompt-injection vocabulary, mirroring the honesty
 *  guard in polish.ts (FORBIDDEN_CLAIM_PATTERNS + its bare-"proven" special case).
 *  Kept in sync by the adversarial eval, which asserts a sanitized title never trips
 *  violatesHonestyClaim() for any adversarial title. All global + case-insensitive. */
const REDACT_PATTERNS: readonly RegExp[] = [
  /\bproven\b/gi, // bare "proven" — the guard's special case (only honest as "not proven")
  /\bproves?\b/gi, // prove / proves
  /\bguarantee\w*/gi, // guarantee / guaranteed / guarantees
  /\bdefinitely\b/gi,
  /\bconfirmed\b/gi,
  /\bcertaint\w*/gi, // certainty / certainties
  /\birrefutabl\w*/gi,
  /\bundeniabl\w*/gi,
  /\bmost (?:reliable|trustworthy|accurate)\b/gi, // naive-method elevation
  /\bmore accurate than\b/gi,
  /ignore (?:all |your )?previous/gi, // prompt-injection echo
  /disregard (?:all |the )?(?:above|previous|prior)/gi,
  /system\s*:/gi, // injected fake "system:" directive (anywhere in a title)
];

/** Redact manufactured-certainty / naive-elevation / injection tokens from an
 *  attacker-controlled title so it can be embedded in the tool's honest prose
 *  without asserting a claim the numbers don't support. Collapses whitespace the
 *  redaction leaves behind. Guarantee: violatesHonestyClaim(sanitizeActionTitle(t))
 *  is false for every t (asserted by the adversarial eval). */
export function sanitizeActionTitle(title: string): string {
  let out = title;
  for (const re of REDACT_PATTERNS) out = out.replace(re, REDACTION);
  return out.replace(/\s+/g, " ").trim();
}
