import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { completeManualAction } from "./manual-completion.ts";

const IDS = {
  scope: "ca5e0000-0000-0000-0000-000000000071",
  action: "ca5e0000-0000-0000-0000-000000000072",
  actor: "ca5e0000-0000-0000-0000-000000000073",
};

function client(response: { data: unknown; error: unknown }, calls: Array<Record<string, unknown>>): SupabaseClient {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return response;
    },
  } as unknown as SupabaseClient;
}

test("manual completion sends one scoped RPC and maps its audit record", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await completeManualAction(client({
    data: [{
      completed_action_id: IDS.action,
      completed_on: "2026-07-22",
      explanation: "Released the assistant behind the approved flag.",
      reused: false,
    }],
    error: null,
  }, calls), {
    scopeId: IDS.scope,
    actionId: IDS.action,
    completedOn: "2026-07-22",
    explanation: "  Released the assistant behind the approved flag.  ",
    authoredBy: IDS.actor,
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.completion.reused, false);
  assert.deepEqual(calls, [{
    name: "complete_manual_action_v1",
    args: {
      p_scope_id: IDS.scope,
      p_action_id: IDS.action,
      p_completed_on: "2026-07-22",
      p_explanation: "Released the assistant behind the approved flag.",
      p_authored_by: IDS.actor,
    },
  }]);
});

test("manual completion rejects malformed input before reaching the database", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await completeManualAction(client({ data: null, error: null }, calls), {
    scopeId: IDS.scope,
    actionId: "not-an-action",
    completedOn: "tomorrow",
    explanation: "",
    authoredBy: IDS.actor,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "validation");
  assert.equal(calls.length, 0);
});

test("manual completion maps authorization failures without leaking the action", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await completeManualAction(client({
    data: null,
    error: { code: "42501", message: "unavailable" },
  }, calls), {
    scopeId: IDS.scope,
    actionId: IDS.action,
    completedOn: "2026-07-22",
    explanation: "Shipped outside the connected tracker.",
    authoredBy: IDS.actor,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "forbidden");
  assert.equal(calls.length, 1);
});
