import type { Action, OwnershipDecision } from "@/domain/contracts";

export function enforceSafety(decision: OwnershipDecision): OwnershipDecision {
  if (!decision.recommendedAction) return decision;

  let recommendedAction: Action | undefined = decision.recommendedAction;
  if (decision.safetyLevel === "LOW") {
    recommendedAction = undefined;
  } else if (decision.safetyLevel === "MEDIUM") {
    recommendedAction = {
      ...recommendedAction,
      status: "pending_approval",
      requiresApproval: true,
    };
  } else {
    recommendedAction = {
      ...recommendedAction,
      status: "not_started",
      requiresApproval: false,
    };
  }

  return { ...decision, recommendedAction };
}