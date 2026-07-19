// Draft a lever ticket FROM a decision (#16 GitHub, #19 Jira — read-only default).
//
// The Supabase client is INJECTED (like lib/onboarding/commit + lib/ingest's
// store) so this runs under the app's server client and under the integration
// test's own client, and stays importable outside the Next runtime.
//
// Draft is the "arming" step: it materializes the lever + its early actions row
// (external_ref NULL — the issue does not exist in the tracker yet) but does NOT
// attribute the prediction. Attribution happens at DETECTION (lib/levers/detect),
// when the user's real issue is matched by its provenance token. Draft is
// idempotent on the provenance token: re-drafting the same decision returns the
// existing lever (+ deep-link) rather than a duplicate.
//
// Tracker-aware: GitHub is the default (unchanged from #16); Jira (#19) rides the
// SAME lever row + token, differing only in the actions.source, the target ref
// (a project key, not owner/repo), and the deep-link builder. The write-scope
// "efficient path" (lib/levers/autocreate) drafts through here too, then creates
// the ticket itself — so it passes no deep-link params (deepLink is null).

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIssueDeepLink, provenanceToken } from "../connectors/github.ts";
import { buildJiraDeepLink } from "../connectors/jira.ts";

export type TargetSource = "github" | "jira";

export type DraftInput = {
  decisionId: string;
  metricId: string;
  /** The drafted ticket title + body (LLM-drafted; see lib/levers/llm). */
  title: string;
  body: string;
  /** Which tracker the lever targets. Defaults to github (the #16 path). */
  targetSource?: TargetSource;
  /** GitHub watch target "owner/name" (required when targetSource is github). */
  repo?: string;
  /** Jira target: project key (target_ref) + optional deep-link params. Omit the
   *  link params for the write-scope auto-create path (no deep-link needed). */
  jira?: { projectKey: string; baseUrl?: string; projectId?: string; issueTypeId?: string };
};

export type DraftResult =
  | {
      ok: true;
      leverId: string;
      actionId: string;
      token: string;
      /** The prefilled create URL (read-only path). Null for auto-create. */
      deepLink: string | null;
      reused: boolean;
    }
  | { ok: false; error: string };

function splitRepo(repo: string): { owner: string; name: string } | null {
  const [owner, name, ...rest] = repo.trim().split("/");
  if (!owner || !name || rest.length > 0) return null;
  return { owner, name };
}

/** Resolve (targetSource, target_ref, actions.source, deepLink) for the tracker. */
function resolveTarget(
  input: DraftInput,
): { source: TargetSource; targetRef: string; actionSource: string; deepLink: string | null } | { error: string } {
  const targetSource = input.targetSource ?? "github";
  if (targetSource === "github") {
    const repo = input.repo ? splitRepo(input.repo) : null;
    if (!repo) return { error: `Watch target must be owner/repo, got "${input.repo ?? ""}".` };
    return {
      source: "github",
      targetRef: input.repo!.trim(),
      actionSource: "github_issue",
      deepLink: buildIssueDeepLink({
        owner: repo.owner,
        repo: repo.name,
        title: input.title,
        body: input.body,
        decisionId: input.decisionId,
      }),
    };
  }
  // Jira.
  const j = input.jira;
  if (!j?.projectKey?.trim()) return { error: "Jira target needs a project key." };
  const deepLink =
    j.baseUrl && j.projectId && j.issueTypeId
      ? buildJiraDeepLink({
          baseUrl: j.baseUrl,
          projectId: j.projectId,
          issueTypeId: j.issueTypeId,
          summary: input.title,
          description: input.body,
          decisionId: input.decisionId,
        })
      : null;
  return { source: "jira", targetRef: j.projectKey.trim(), actionSource: "jira", deepLink };
}

/**
 * Draft a lever for (decision, metric): one `actions` row (external_ref NULL,
 * scope-scoped), a `decision_actions` link, and a `levers` row status=DRAFTED
 * carrying the provenance token + drafted payload. Returns the prefilled
 * deep-link the user clicks to create the issue (null for the auto-create path).
 */
export async function draftLeverFromDecision(
  sb: SupabaseClient,
  scopeId: string,
  input: DraftInput,
): Promise<DraftResult> {
  const target = resolveTarget(input);
  if ("error" in target) return { ok: false, error: target.error };
  const token = provenanceToken(input.decisionId);

  // Idempotent: a lever with this provenance token already exists → return it.
  const existing = await sb
    .from("levers")
    .select("lever_id, action_id")
    .eq("provenance_token", token)
    .maybeSingle();
  if (existing.error) return { ok: false, error: existing.error.message };
  if (existing.data) {
    const row = existing.data as { lever_id: string; action_id: string };
    return {
      ok: true,
      leverId: row.lever_id,
      actionId: row.action_id,
      token,
      deepLink: target.deepLink,
      reused: true,
    };
  }

  // 1. The early actions row (external_ref NULL until detection).
  const rationale = {
    type: "doc",
    title: input.title,
    content: [{ type: "paragraph", content: [{ type: "text", text: input.body }] }],
    meta: { provenance_token: token, target_ref: target.targetRef, target_source: target.source },
  };
  const actionRes = await sb
    .from("actions")
    .insert({
      scope_id: scopeId,
      source: target.actionSource,
      external_ref: null,
      status: "draft",
      rationale_richtext: rationale,
    })
    .select("action_id")
    .single();
  if (actionRes.error) return { ok: false, error: actionRes.error.message };
  const actionId = (actionRes.data as { action_id: string }).action_id;

  // 2. Link it to the decision.
  const daRes = await sb
    .from("decision_actions")
    .insert({ decision_id: input.decisionId, action_id: actionId });
  if (daRes.error) return { ok: false, error: daRes.error.message };

  // 3. The lever — DRAFTED, provenance token is the idempotency key.
  const leverRes = await sb
    .from("levers")
    .insert({
      scope_id: scopeId,
      decision_id: input.decisionId,
      action_id: actionId,
      metric_id: input.metricId,
      provenance_token: token,
      target_source: target.source,
      target_ref: target.targetRef,
      status: "DRAFTED",
      drafted_payload: {
        title: input.title,
        body: input.body,
        label: token,
        deep_link: target.deepLink,
        target_source: target.source,
      },
    })
    .select("lever_id")
    .single();
  if (leverRes.error) return { ok: false, error: leverRes.error.message };

  return {
    ok: true,
    leverId: (leverRes.data as { lever_id: string }).lever_id,
    actionId,
    token,
    deepLink: target.deepLink,
    reused: false,
  };
}
