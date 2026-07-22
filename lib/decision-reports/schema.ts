export const CLAIM_STATUSES = [
  "sourced",
  "inferred",
  "suggested",
  "missing",
  "user_confirmed",
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export type Claim = {
  id: string;
  text: string;
  status: ClaimStatus;
  sourceChunkIds: string[];
};

export type DraftAction = {
  sourceItemId: string;
  title: string;
  summary: Claim[];
  owner: Claim | null;
};

export type DecisionReportV1 = {
  schemaVersion: 1;
  title: string;
  decision: {
    decision: Claim[];
    background: Claim[];
    problem: Claim[];
  };
  supportingEvidence: {
    factors: Claim[];
    metricMechanism: Claim[];
    alternatives: Claim[];
    precedent: Claim[];
  };
  implementation: {
    actionPlanSummary: Claim[];
    actions: DraftAction[];
    cost: Claim[];
    customers: Claim[];
    stakeholders: Claim[];
    assetIds: string[];
    governance: {
      dataClassification: "private" | "organization" | "public" | null;
      allowedDataSources: Claim[];
      approvedModelNotes: Claim[];
    };
  };
};

export type MetricProjection = {
  metricName: string;
  definition: string;
  baselinePct: number | null;
  predictedPct: number | null;
  baselineLabel: string;
  predictionLabel: string;
  evidenceState: "illustrative_assumption" | "prompt_supplied" | "missing";
};

export type DecisionReportGoldenExample = {
  projectName: string;
  workspaceName: string;
  initialPrompt: string;
  report: DecisionReportV1;
  metricProjection: MetricProjection;
};

export type ValidationResult =
  | { success: true; data: DecisionReportV1 }
  | { success: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateClaim(value: unknown, path: string, errors: string[]): value is Claim {
  if (!isRecord(value)) {
    errors.push(`${path} must be a claim object`);
    return false;
  }

  if (typeof value.id !== "string" || value.id.trim() === "") {
    errors.push(`${path}.id must be a non-empty string`);
  }
  if (typeof value.text !== "string") {
    errors.push(`${path}.text must be a string`);
  }
  if (!CLAIM_STATUSES.includes(value.status as ClaimStatus)) {
    errors.push(`${path}.status is invalid`);
  }
  if (!Array.isArray(value.sourceChunkIds) || value.sourceChunkIds.some((id) => typeof id !== "string")) {
    errors.push(`${path}.sourceChunkIds must be a string array`);
  }

  if (value.status === "sourced" && Array.isArray(value.sourceChunkIds) && value.sourceChunkIds.length === 0) {
    errors.push(`${path} is sourced but has no source chunk`);
  }
  if (value.status === "missing" && typeof value.text === "string" && value.text.trim() !== "") {
    errors.push(`${path} is missing but contains text`);
  }
  if (value.status !== "sourced" && Array.isArray(value.sourceChunkIds) && value.sourceChunkIds.length > 0) {
    errors.push(`${path} has source chunks but is not sourced`);
  }

  return errors.length === 0;
}

function validateClaimArray(value: unknown, path: string, errors: string[]): value is Claim[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return false;
  }
  value.forEach((claim, index) => validateClaim(claim, `${path}[${index}]`, errors));
  return true;
}

function validateAction(value: unknown, path: string, errors: string[]): value is DraftAction {
  if (!isRecord(value)) {
    errors.push(`${path} must be an action object`);
    return false;
  }

  if (typeof value.sourceItemId !== "string" || value.sourceItemId.trim() === "") {
    errors.push(`${path}.sourceItemId must be a non-empty string`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    errors.push(`${path}.title must be a non-empty string`);
  }
  validateClaimArray(value.summary, `${path}.summary`, errors);
  if (value.owner !== null) validateClaim(value.owner, `${path}.owner`, errors);
  return true;
}

export function validateDecisionReport(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { success: false, errors: ["report must be an object"] };

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof value.title !== "string" || value.title.trim() === "") {
    errors.push("title must be a non-empty string");
  }

  const decision = value.decision;
  if (!isRecord(decision)) {
    errors.push("decision must be an object");
  } else {
    validateClaimArray(decision.decision, "decision.decision", errors);
    validateClaimArray(decision.background, "decision.background", errors);
    validateClaimArray(decision.problem, "decision.problem", errors);
  }

  const evidence = value.supportingEvidence;
  if (!isRecord(evidence)) {
    errors.push("supportingEvidence must be an object");
  } else {
    validateClaimArray(evidence.factors, "supportingEvidence.factors", errors);
    validateClaimArray(evidence.metricMechanism, "supportingEvidence.metricMechanism", errors);
    validateClaimArray(evidence.alternatives, "supportingEvidence.alternatives", errors);
    validateClaimArray(evidence.precedent, "supportingEvidence.precedent", errors);
  }

  const implementation = value.implementation;
  if (!isRecord(implementation)) {
    errors.push("implementation must be an object");
  } else {
    validateClaimArray(implementation.actionPlanSummary, "implementation.actionPlanSummary", errors);
    validateClaimArray(implementation.cost, "implementation.cost", errors);
    validateClaimArray(implementation.customers, "implementation.customers", errors);
    validateClaimArray(implementation.stakeholders, "implementation.stakeholders", errors);

    if (!Array.isArray(implementation.actions)) {
      errors.push("implementation.actions must be an array");
    } else {
      if (implementation.actions.length > 7) errors.push("implementation.actions cannot exceed 7 items");
      implementation.actions.forEach((action, index) =>
        validateAction(action, `implementation.actions[${index}]`, errors),
      );
    }

    if (!Array.isArray(implementation.assetIds) || implementation.assetIds.some((id) => typeof id !== "string")) {
      errors.push("implementation.assetIds must be a string array");
    }

    const governance = implementation.governance;
    if (!isRecord(governance)) {
      errors.push("implementation.governance must be an object");
    } else {
      if (![null, "private", "organization", "public"].includes(
        governance.dataClassification as null | string,
      )) {
        errors.push("implementation.governance.dataClassification is invalid");
      }
      validateClaimArray(
        governance.allowedDataSources,
        "implementation.governance.allowedDataSources",
        errors,
      );
      validateClaimArray(
        governance.approvedModelNotes,
        "implementation.governance.approvedModelNotes",
        errors,
      );
    }
  }

  return errors.length === 0
    ? { success: true, data: value as DecisionReportV1 }
    : { success: false, errors };
}

export function cloneDecisionReport(report: DecisionReportV1): DecisionReportV1 {
  return structuredClone(report);
}
