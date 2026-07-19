// Write-scope auto-create (#19, the "efficient path") — draft → create → detect,
// zero user clicks. The opt-in upgrade over the read-only deep-link: with a
// write-scoped credential Causent creates the lever ticket itself and attributes
// the prediction immediately.
//
// Injected client + injected IssueCreator (lib/connectors/write) so the whole
// orchestration is exercised against a MOCK tracker with zero credentials.
//
// Idempotent on the provenance token, at TWO layers: draft reuses an existing
// lever, and — critically — this never POSTs a second ticket for a lever that has
// already been created/detected (a duplicate GitHub/Jira issue is not undoable).

import type { SupabaseClient } from "@supabase/supabase-js";
import { draftLeverFromDecision, type DraftInput } from "./draft.ts";
import { detectLever } from "./detect.ts";
import type { IssueCreator } from "../connectors/write.ts";

export type AutoCreateResult =
  | {
      ok: true;
      leverId: string;
      externalRef: string;
      url: string;
      strategy: string;
      alreadyCreated: boolean;
    }
  | { ok: false; error: string };

/** A lever that has moved past DRAFTED/CREATED has (or is getting) a real ticket;
 *  re-creating would duplicate it. */
const CREATE_ALREADY_DONE = new Set(["DETECTED", "SHIPPED", "DROPPED"]);

export async function autoCreateLever(
  sb: SupabaseClient,
  scopeId: string,
  input: DraftInput,
  creator: IssueCreator,
): Promise<AutoCreateResult> {
  // 1. Draft (idempotent) — DRAFTED lever + early actions row (external_ref NULL).
  const draft = await draftLeverFromDecision(sb, scopeId, input);
  if (!draft.ok) return { ok: false, error: draft.error };

  // 2. Idempotency guard: if this lever already has a ticket, do NOT create a
  //    second one — return what it already resolved to.
  const cur = await sb
    .from("levers")
    .select("status, drafted_payload, action_id")
    .eq("lever_id", draft.leverId)
    .maybeSingle();
  if (cur.error) return { ok: false, error: cur.error.message };
  const status = (cur.data as { status?: string } | null)?.status;
  const payload = ((cur.data as { drafted_payload?: Record<string, unknown> } | null)?.drafted_payload ??
    {}) as Record<string, unknown>;
  const actionId = (cur.data as { action_id?: string } | null)?.action_id;

  if ((status && CREATE_ALREADY_DONE.has(status)) || payload.auto_created) {
    const existingRef = await currentExternalRef(sb, actionId);
    return {
      ok: true,
      leverId: draft.leverId,
      externalRef: existingRef ?? "",
      url: String(payload.detected_url ?? ""),
      strategy: String(payload.auto_create_strategy ?? "label"),
      alreadyCreated: true,
    };
  }

  // 3. Create the ticket in the tracker (the one non-idempotent step — guarded above).
  let created;
  try {
    created = await creator.create({
      decisionId: input.decisionId,
      title: input.title,
      body: input.body,
    });
  } catch (err) {
    return { ok: false, error: `Auto-create failed: ${String(err)}` };
  }

  // 4. Attribute it through the SAME detector the webhook + paste path use.
  const det = await detectLever(sb, {
    token: draft.token,
    externalRef: created.externalRef,
    htmlUrl: created.url,
  });
  if (!det.ok) {
    return { ok: false, error: "Created the ticket but attribution failed — reconcile will retry." };
  }

  // 5. Record the auto-create provenance on the lever (surfaces the fast lane).
  await sb
    .from("levers")
    .update({
      drafted_payload: {
        ...payload,
        auto_created: true,
        auto_create_strategy: created.strategy,
        detected_url: created.url,
      },
    })
    .eq("lever_id", draft.leverId);

  return {
    ok: true,
    leverId: draft.leverId,
    externalRef: created.externalRef,
    url: created.url,
    strategy: created.strategy,
    alreadyCreated: false,
  };
}

async function currentExternalRef(
  sb: SupabaseClient,
  actionId: string | undefined,
): Promise<string | null> {
  if (!actionId) return null;
  const res = await sb.from("actions").select("external_ref").eq("action_id", actionId).maybeSingle();
  if (res.error || !res.data) return null;
  return (res.data as { external_ref: string | null }).external_ref;
}
