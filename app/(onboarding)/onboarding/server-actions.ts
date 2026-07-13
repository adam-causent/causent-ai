"use server";

// Server actions for the onboarding funnel (C2/#15).
//
// Trust model: writes run through the pinned demo-scope server client resolved
// via the dev-session seam (lib/auth/session.ts) — the ONE place issue #5's
// real auth plugs in. Validation and DB logic live in lib/onboarding/* (pure +
// injected-client, unit/integration tested); this file only wires session,
// client, and cache revalidation.
//
// Elicit-not-assert, structurally: nothing here computes, suggests, or
// pre-fills a magnitude. The LLM seam structures the paste and interrogates;
// the TEAM types the number in Step 4.

import { revalidatePath } from "next/cache";
import { getServerSupabase } from "@/lib/supabase-server";
import { getSession } from "@/lib/auth/session";
import { parsePasteWithLLM } from "@/lib/onboarding/llm";
import type { DecisionCard } from "@/lib/onboarding/parse";
import {
  commitPrediction,
  declareMetric,
  type CommitInput,
  type CommitResult,
  type DeclareMetricResult,
} from "@/lib/onboarding/commit";
import { getPriorsForReferenceClass } from "@/lib/data/priors";
import type { ReferenceClassPriors } from "@/lib/priors";
import { draftLeverFromDecision } from "@/lib/levers/draft";
import { detectLever, markLeverCreated, parseIssueUrl } from "@/lib/levers/detect";
import { draftTicketCopy } from "@/lib/levers/llm";
import { issueExternalRef } from "@/lib/connectors/github";

/** Step 2 -> 3: structure the paste into a decision card + interrogation.
 *  Fail-safe by construction — garbage or model trouble yields the fallback
 *  card (manual metric entry), never a dead-end. */
export async function structurePaste(paste: string): Promise<DecisionCard> {
  return parsePasteWithLLM(paste);
}

/** Step 3 -> 4: resolve the metric the prediction will commit against —
 *  reuse a wired metric when the name matches one, else create exactly one
 *  declared (name-only, no observations) row. */
export async function declareOnboardingMetric(
  name: string,
): Promise<DeclareMetricResult | { error: string }> {
  const session = await getSession();
  return declareMetric(await getServerSupabase(), session.workspaceId, name);
}

/** Step 4 precedent: the reference-class priors behind the panel. On a fresh
 *  declared metric this is honestly empty ("no precedent yet"). */
export async function fetchOnboardingPriors(params: {
  metricId: string;
  mechanismCategory?: string | null;
}): Promise<ReferenceClassPriors> {
  return getPriorsForReferenceClass(params);
}

/** Step 4 commit: decision + prediction, RLS-scoped to the session workspace.
 *  The prediction persists UNATTRIBUTED (no lever yet — armed in C3). */
export async function commitOnboardingPrediction(
  input: CommitInput,
): Promise<CommitResult> {
  const session = await getSession();
  const result = await commitPrediction(await getServerSupabase(), session.workspaceId, input);
  if (result.ok) revalidatePath("/actions");
  return result;
}

/** Step 6 (create-from-decision, read-only default): draft the ticket copy
 *  (LLM, fail-safe), materialize the DRAFTED lever + early actions row, and
 *  return the prefilled deep-link the user clicks to create the issue in their
 *  own repo. The prediction stays unattributed until detection. */
export async function draftLeverForDecision(input: {
  decisionId: string;
  metricId: string;
  repo: string;
  title: string;
  mechanismSummary: string;
  mechanismCategory?: string | null;
}): Promise<
  | { ok: true; deepLink: string; token: string; reused: boolean }
  | { ok: false; error: string }
> {
  const session = await getSession();
  const copy = await draftTicketCopy({
    title: input.title,
    mechanismSummary: input.mechanismSummary,
    mechanismCategory: input.mechanismCategory ?? null,
  });
  const res = await draftLeverFromDecision(await getServerSupabase(), session.workspaceId, {
    decisionId: input.decisionId,
    metricId: input.metricId,
    repo: input.repo,
    title: copy.title,
    body: copy.body,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/actions");
  return { ok: true, deepLink: res.deepLink, token: res.token, reused: res.reused };
}

/** Step 6 paste-URL fallback: the user created the issue and pastes its URL.
 *  Marks the lever CREATED then detects it (same detector the webhook uses) —
 *  attributing the prediction with no GitHub credentials at all. */
export async function attributeLeverByUrl(input: {
  token: string;
  url: string;
}): Promise<
  | { ok: true; attributed: boolean; externalRef: string }
  | { ok: false; error: string }
> {
  const parsed = parseIssueUrl(input.url);
  if (!parsed) {
    return { ok: false, error: "That doesn’t look like a GitHub issue URL (…/issues/123)." };
  }
  const sb = await getServerSupabase();
  await markLeverCreated(sb, input.token);
  const externalRef = issueExternalRef(parsed.number);
  const det = await detectLever(sb, {
    token: input.token,
    externalRef,
    htmlUrl: input.url.trim(),
  });
  if (!det.ok) {
    return { ok: false, error: "No draft lever matched — draft the ticket first." };
  }
  revalidatePath("/actions");
  return { ok: true, attributed: true, externalRef };
}
