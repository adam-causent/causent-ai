import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { GUMMY_ALPHA_GOLDEN_EXAMPLE } from "./fixtures/gummy-alpha.ts";
import { createSafeFallbackReport } from "./generation-contract.ts";
import { deleteDecisionReport, saveDecisionReport } from "./persistence.ts";

const SCOPE_ID = "ca5e0000-0000-0000-0000-0000000000d3";
const REPORT_ID = "ca5e0000-0000-0000-0000-0000000000e1";
const REVISION_ID = "ca5e0000-0000-0000-0000-0000000000e2";

function rpcClient(calls: Array<{ name: string; args: Record<string, unknown> }>): SupabaseClient {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        data: [{
          report_id: REPORT_ID,
          revision_id: REVISION_ID,
          base_revision_id: null,
          status: args.p_status,
          content_hash: "a".repeat(32),
          reused: false,
          saved_at: "2026-07-21T12:00:00.000Z",
        }],
        error: null,
      };
    },
  } as unknown as SupabaseClient;
}

function staleConflictClient(): SupabaseClient {
  return {
    async rpc() {
      return {
        data: null,
        error: {
          code: "PT409",
          message: "STALE_REVISION",
          details: REVISION_ID,
          hint: null,
          name: "PostgrestError",
        },
      };
    },
  } as unknown as SupabaseClient;
}

test("save derives report_ready and calls the create RPC for a new complete report", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await saveDecisionReport(rpcClient(calls), SCOPE_ID, {
    reportId: null,
    baseRevisionId: null,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "create_decision_report_v1");
  assert.equal(calls[0].args.p_status, "report_ready");
});

test("save derives draft for the sparse fallback", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let index = 0;
  const fallback = createSafeFallbackReport("Launch a new partner onboarding experience.", {
    idFactory: () => `fallback-${index++}`,
  });
  const result = await saveDecisionReport(rpcClient(calls), SCOPE_ID, {
    reportId: null,
    baseRevisionId: null,
    report: fallback.report,
    metricProjection: fallback.metricProjection,
    authoredBy: null,
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].args.p_status, "draft");
});

test("save rejects invalid revision addresses before touching the database", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await saveDecisionReport(rpcClient(calls), SCOPE_ID, {
    reportId: REPORT_ID,
    baseRevisionId: null,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "validation");
  assert.equal(calls.length, 0);
});

test("save maps an immediate PostgREST 409 to a revision conflict", async () => {
  const result = await saveDecisionReport(staleConflictClient(), SCOPE_ID, {
    reportId: REPORT_ID,
    baseRevisionId: REVISION_ID,
    report: GUMMY_ALPHA_GOLDEN_EXAMPLE.report,
    metricProjection: GUMMY_ALPHA_GOLDEN_EXAMPLE.metricProjection,
    authoredBy: null,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "conflict");
    assert.equal(result.currentRevisionId, REVISION_ID);
  }
});

test("delete calls the checked RPC and validates its receipt", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        data: [{ report_id: REPORT_ID, deleted_at: "2026-07-22T20:00:00Z", reused: false }],
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  const result = await deleteDecisionReport(client, SCOPE_ID, REPORT_ID, null);
  assert.equal(result.ok, true);
  assert.equal(calls[0].name, "delete_decision_report_v1");
  assert.deepEqual(calls[0].args, {
    p_scope_id: SCOPE_ID,
    p_report_id: REPORT_ID,
    p_authored_by: null,
  });
});
