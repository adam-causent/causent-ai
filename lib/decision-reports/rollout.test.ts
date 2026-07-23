import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveOnboardingFlow } from "./rollout.ts";

test("unassigned new starts use the legacy rollback path", () => {
  assert.equal(resolveOnboardingFlow({
    requestedFlow: null,
    hasSavedReport: false,
    rolloutEnabled: false,
  }), "legacy");
});

test("enabled new starts use Decision Report", () => {
  assert.equal(resolveOnboardingFlow({
    requestedFlow: null,
    hasSavedReport: false,
    rolloutEnabled: true,
  }), "decision-report");
});

test("an in-progress legacy URL is never migrated when rollout becomes enabled", () => {
  assert.equal(resolveOnboardingFlow({
    requestedFlow: "legacy",
    hasSavedReport: false,
    rolloutEnabled: true,
  }), "legacy");
});

test("disabling rollout sends an unsaved Decision Report start to legacy", () => {
  assert.equal(resolveOnboardingFlow({
    requestedFlow: "decision-report",
    hasSavedReport: false,
    rolloutEnabled: false,
  }), "legacy");
});

test("saved reports survive rollback and remain directly reachable", () => {
  assert.equal(resolveOnboardingFlow({
    requestedFlow: null,
    hasSavedReport: true,
    rolloutEnabled: false,
  }), "decision-report");
});
