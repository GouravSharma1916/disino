export type EvidenceSource = "notion" | "github" | "slack";

export type SafetyLevel = "HIGH" | "MEDIUM" | "LOW";

export type EvidenceAvailability = "available" | "missing" | "conflicting";

export type InvestigationStatus =
  | "complete"
  | "needs_approval"
  | "blocked";

export type ActionStatus =
  | "not_started"
  | "pending_approval"
  | "executed"
  | "failed"
  | "not_allowed";

export type VerificationStatus = "pending" | "confirmed" | "failed";

export type ActionResultStatus = "succeeded" | "failed" | "not_attempted";

export interface ActorReference {
  id?: string;
  name?: string;
  handle?: string;
}

export interface Evidence {
  id: string;
  source: EvidenceSource;
  type: string;
  content: string;
  timestamp: string;
  relatedTask?: string;
  relatedRelease?: string;
  person?: ActorReference;
  confidence: number;
  relevance: number;
  availability: EvidenceAvailability;
  missingReason?: string;
  conflictingEvidenceIds?: string[];
}

export interface Action {
  id: string;
  type: string;
  target: string;
  reason: string;
  status: ActionStatus;
  requiresApproval: boolean;
}

export interface ActionResult {
  actionId: string;
  source: EvidenceSource;
  status: ActionResultStatus;
  message: string;
}

export interface ActionExecutionResult {
  status: "succeeded" | "partial_failure" | "failed" | "blocked";
  results: ActionResult[];
}

export interface VerificationResult {
  actionId: string;
  source: EvidenceSource;
  status: VerificationStatus;
  expectedState: string;
  actualState: string;
  verified: boolean;
  verifiedAt?: string;
  evidence: Evidence[];
  details?: string;
}

export interface VerificationExecutionResult {
  status: "succeeded" | "partial_failure" | "failed";
  results: VerificationResult[];
}

export interface OwnershipDecision {
  plannedOwner?: ActorReference;
  operationalOwner?: ActorReference;
  confidence: number;
  safetyLevel: SafetyLevel;
  supportingEvidence: Evidence[];
  conflictingEvidence: Evidence[];
  missingEvidence: Evidence[];
  reasoning: string;
  challenge: string;
  recommendedAction?: Action;
  verificationRequirements: string[];
}

export interface InvestigationResult {
  investigationId: string;
  taskId: string;
  status: InvestigationStatus;
  evidence: Evidence[];
  missingEvidence: Evidence[];
  conflictingEvidence: Evidence[];
  ownershipDecision: OwnershipDecision;
  action?: Action;
  verification?: VerificationResult;
  createdAt: string;
}
