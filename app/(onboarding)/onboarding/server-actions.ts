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
import { recordFunnelEvent, type RecordFunnelEventInput } from "@/lib/data/funnel";
import { draftLeverFromDecision, type TargetSource } from "@/lib/levers/draft";
import { detectLever, markLeverCreated, parseIssueUrl } from "@/lib/levers/detect";
import { autoCreateLever } from "@/lib/levers/autocreate";
import { draftTicketCopy } from "@/lib/levers/llm";
import { issueExternalRef } from "@/lib/connectors/github";
import { jiraIssueExternalRef, parseJiraIssueUrl } from "@/lib/connectors/jira";
import {
  createGitHubWriteTransport,
  createJiraWriteTransport,
  gitHubIssueCreator,
  jiraIssueCreator,
  type IssueCreator,
} from "@/lib/connectors/write";

/** The Jira target params the read-only deep-link + write-scope create need. */
type JiraTarget = {
  projectKey: string;
  baseUrl?: string;
  projectId?: string;
  issueTypeId?: string;
};

/** Funnel instrumentation (C2/#15 DoD). Best-effort by contract: an insert
 *  failure must never break the funnel, so this swallows errors and always
 *  resolves — the client fires it and forgets. The server clock stamps the row;
 *  the client only measures ms_since_start (landing -> first keystroke). */
export async function recordOnboardingEvent(
  input: RecordFunnelEventInput,
): Promise<void> {
  try {
    const session = await getSession();
    await recordFunnelEvent(
      await getServerSupabase(),
      session.workspaceId,
      session.userId,
      input,
    );
  } catch {
    // Instrumentation is non-critical; never surface to the funnel.
  }
}

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
  /** GitHub watch target "owner/repo" (when targetSource is github). */
  repo?: string;
  /** Jira target (when targetSource is jira). */
  jira?: JiraTarget;
  targetSource?: TargetSource;
  title: string;
  mechanismSummary: string;
  mechanismCategory?: string | null;
}): Promise<
  | { ok: true; deepLink: string | null; token: string; reused: boolean }
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
    targetSource: input.targetSource ?? "github",
    repo: input.repo,
    jira: input.jira,
    title: copy.title,
    body: copy.body,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/actions");
  return { ok: true, deepLink: res.deepLink, token: res.token, reused: res.reused };
}

/** Step 6 write-scope EFFICIENT path (#19): with a write-scoped credential
 *  configured, Causent drafts AND creates the lever ticket itself and attributes
 *  the prediction in one shot — zero user clicks. Falls back with
 *  `writeUnavailable` when no write credential is set, so the UI can offer the
 *  read-only deep-link instead. Idempotent (never creates a duplicate ticket). */
export async function autoCreateLeverForDecision(input: {
  decisionId: string;
  metricId: string;
  repo?: string;
  jira?: JiraTarget;
  targetSource?: TargetSource;
  title: string;
  mechanismSummary: string;
  mechanismCategory?: string | null;
}): Promise<
  | { ok: true; externalRef: string; url: string; strategy: string; alreadyCreated: boolean }
  | { ok: false; error: string; writeUnavailable?: boolean }
> {
  const targetSource = input.targetSource ?? "github";
  const creator = writeCreatorFromEnv(targetSource, input.repo, input.jira);
  if (!creator) {
    return {
      ok: false,
      writeUnavailable: true,
      error:
        targetSource === "github"
          ? "No GitHub write credential configured — use the one-click create link instead."
          : "No Jira write credential configured — use the one-click create link instead.",
    };
  }
  const session = await getSession();
  const copy = await draftTicketCopy({
    title: input.title,
    mechanismSummary: input.mechanismSummary,
    mechanismCategory: input.mechanismCategory ?? null,
  });
  const res = await autoCreateLever(
    await getServerSupabase(),
    session.workspaceId,
    {
      decisionId: input.decisionId,
      metricId: input.metricId,
      targetSource,
      repo: input.repo,
      jira: input.jira,
      title: copy.title,
      body: copy.body,
    },
    creator,
  );
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/actions");
  return {
    ok: true,
    externalRef: res.externalRef,
    url: res.url,
    strategy: res.strategy,
    alreadyCreated: res.alreadyCreated,
  };
}

/** Build a live write creator from env, or null when no write credential is set.
 *  GitHub: GITHUB_WRITE_TOKEN (else GITHUB_TOKEN). Jira: JIRA_BASE_URL + JIRA_EMAIL
 *  + JIRA_API_TOKEN (basic-auth v1). This is the "write scope granted" signal. */
function writeCreatorFromEnv(
  targetSource: TargetSource,
  repo: string | undefined,
  jira: JiraTarget | undefined,
): IssueCreator | null {
  if (targetSource === "github") {
    const token = process.env.GITHUB_WRITE_TOKEN ?? process.env.GITHUB_TOKEN;
    const parts = repo?.trim().split("/");
    if (!token || !parts || parts.length !== 2) return null;
    return gitHubIssueCreator(createGitHubWriteTransport(token), {
      owner: parts[0],
      repo: parts[1],
    });
  }
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !apiToken || !jira?.projectKey || !jira.issueTypeId) return null;
  return jiraIssueCreator(createJiraWriteTransport({ email, apiToken }), {
    baseUrl,
    projectKey: jira.projectKey,
    issueTypeId: jira.issueTypeId,
  });
}

/** Step 6 paste-URL fallback: the user created the issue and pastes its URL.
 *  Marks the lever CREATED then detects it (same detector the webhook uses) —
 *  attributing the prediction with no tracker credentials at all. Handles both
 *  a GitHub issue URL and a Jira /browse/KEY-n URL. */
export async function attributeLeverByUrl(input: {
  token: string;
  url: string;
}): Promise<
  | { ok: true; attributed: boolean; externalRef: string }
  | { ok: false; error: string }
> {
  const url = input.url.trim();
  const gh = parseIssueUrl(url);
  const jira = gh ? null : parseJiraIssueUrl(url);
  const externalRef = gh
    ? issueExternalRef(gh.number)
    : jira
      ? jiraIssueExternalRef(jira.key)
      : null;
  if (!externalRef) {
    return {
      ok: false,
      error: "That doesn’t look like a GitHub (…/issues/123) or Jira (…/browse/ABC-123) issue URL.",
    };
  }
  const sb = await getServerSupabase();
  await markLeverCreated(sb, input.token);
  const det = await detectLever(sb, { token: input.token, externalRef, htmlUrl: url });
  if (!det.ok) {
    return { ok: false, error: "No draft lever matched — draft the ticket first." };
  }
  revalidatePath("/actions");
  return { ok: true, attributed: true, externalRef };
}
