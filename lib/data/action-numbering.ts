import type { Action, Decision } from "@/lib/types";
import type { DecisionReportV1 } from "@/lib/decision-reports/schema";

/**
 * Add stable, human-readable decision/action coordinates to the visible view.
 * Decisions are numbered oldest-first; report-native actions retain the order
 * reviewed in the durable report rather than inheriting database join order.
 */
export function numberDecisionActions(
  decisions: Decision[],
  actions: Action[],
  report: DecisionReportV1 | null = null,
): Action[] {
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const codeByActionId = new Map<string, string>();
  const reportOrder = new Map(
    (report?.implementation.actions ?? []).map((action, index) => [action.sourceItemId, index]),
  );

  const chronological = [...decisions].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  chronological.forEach((decision, decisionIndex) => {
    const actionIds = [...decision.actionIds];
    if (decision.origin === "decision_report" && reportOrder.size > 0) {
      actionIds.sort((leftId, rightId) => {
        const leftOrder = reportOrder.get(actionById.get(leftId)?.sourceItemId ?? "");
        const rightOrder = reportOrder.get(actionById.get(rightId)?.sourceItemId ?? "");
        return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
      });
    }
    actionIds.forEach((actionId, actionIndex) => {
      if (!codeByActionId.has(actionId)) {
        codeByActionId.set(actionId, `D${decisionIndex + 1}A${actionIndex + 1}`);
      }
    });
  });

  return actions.map((action) => ({
    ...action,
    displayCode: codeByActionId.get(action.id),
  }));
}
