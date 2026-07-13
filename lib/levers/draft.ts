// Draft a lever ticket FROM a decision (#16, Step 6 — read-only default).
//
// The Supabase client is INJECTED (like lib/onboarding/commit + lib/ingest's
// store) so this runs under the app's server client and under the integration
// test's own client, and stays importable outside the Next runtime.
//
// Draft is the "arming" step: it materializes the lever + its early actions row
// (external_ref NULL — the issue does not exist in GitHub yet) but does NOT
// attribute the prediction. Attribution happens at DETECTION (lib/levers/detect),
// when the user's real issue is matched by its provenance label. Draft is
// idempotent on the provenance token: re-drafting the same decision returns the
// existing lever + deep-link rather than a duplicate.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildIssueDeepLink,
  provenanceToken,
  type DeepLinkParams,
} from "../connectors/github.ts";

export type DraftInput = {
  decisionId: string;
  metricId: string;
  /** Watch-target repo "owner/name" (selected at the Step-5 connector ask). */
  repo: string;
  /** The drafted ticket title + body (LLM-drafted; see lib/levers/llm). */
  title: string;
  body: string;
  targetSource?: "github" | "jira";
};

export type DraftResult =
  | {
      ok: true;
      leverId: string;
      actionId: string;
      token: string;
      deepLink: string;
      reused: boolean;
    }
  | { ok: false; error: string };

function splitRepo(repo: string): { owner: string; name: string } | null {
  const [owner, name, ...rest] = repo.trim().split("/");
  if (!owner || !name || rest.length > 0) return null;
  return { owner, name };
}

/**
 * Draft a lever for (decision, metric): one `actions` row (github_issue,
 * external_ref NULL, scope-scoped), a `decision_actions` link, and a `levers`
 * row status=DRAFTED carrying the provenance token + drafted payload. Returns
 * the prefilled deep-link the user clicks to create the issue in their own repo.
 */
export async function draftLeverFromDecision(
  sb: SupabaseClient,
  scopeId: string,
  input: DraftInput,
): Promise<DraftResult> {
  const repo = splitRepo(input.repo);
  if (!repo) return { ok: false, error: `Watch target must be owner/repo, got "${input.repo}".` };
  const token = provenanceToken(input.decisionId);
  const targetSource = input.targetSource ?? "github";

  const linkParams: DeepLinkParams = {
    owner: repo.owner,
    repo: repo.name,
    title: input.title,
    body: input.body,
    decisionId: input.decisionId,
  };
  const deepLink = buildIssueDeepLink(linkParams);

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
      deepLink,
      reused: true,
    };
  }

  // 1. The early actions row (external_ref NULL until detection).
  const rationale = {
    type: "doc",
    title: input.title,
    content: [{ type: "paragraph", content: [{ type: "text", text: input.body }] }],
    meta: { provenance_token: token, target_repo: input.repo },
  };
  const actionRes = await sb
    .from("actions")
    .insert({
      scope_id: scopeId,
      source: "github_issue",
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
      target_source: targetSource,
      target_ref: input.repo,
      status: "DRAFTED",
      drafted_payload: { title: input.title, body: input.body, label: token, deep_link: deepLink },
    })
    .select("lever_id")
    .single();
  if (leverRes.error) return { ok: false, error: leverRes.error.message };

  return {
    ok: true,
    leverId: (leverRes.data as { lever_id: string }).lever_id,
    actionId,
    token,
    deepLink,
    reused: false,
  };
}
