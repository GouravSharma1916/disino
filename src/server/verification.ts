import type {
  ActionExecutionResult,
  ActionResult,
  VerificationExecutionResult,
  VerificationResult,
} from "@/domain/contracts";
import {
  verifyIssueOwner,
  type GithubOwnershipUpdateRequest,
} from "@/server/integrations/github";
import {
  verifyOwnershipNotification,
  type SlackNotificationRequest,
} from "@/server/integrations/slack";
import {
  verifyTaskContext,
  type NotionContextUpdateRequest,
} from "@/server/integrations/notion";

export interface VerificationPlan {
  actionExecution: ActionExecutionResult;
  actions: Array<{
    id: string;
    type: string;
  }>;
  github?: GithubOwnershipUpdateRequest;
  slack?: SlackNotificationRequest;
  notion?: NotionContextUpdateRequest;
}

function failedResult(action: ActionResult, message: string): VerificationResult {
  return {
    actionId: action.actionId,
    source: action.source,
    status: "failed",
    expectedState: "action must have executed successfully",
    actualState: message,
    verified: false,
    evidence: [],
    details: message,
  };
}

export async function verifyCorrectiveActions(
  plan: VerificationPlan,
): Promise<VerificationExecutionResult> {
  const results: VerificationResult[] = [];
  for (const actionResult of plan.actionExecution.results) {
    const action = plan.actions.find((item) => item.id === actionResult.actionId);
    if (actionResult.status !== "succeeded" || !action) {
      results.push(failedResult(actionResult, "The action was not confirmed as successfully executed."));
      continue;
    }

    let outcome;
    if (action.type === "github.update_owner" && plan.github) {
      outcome = await verifyIssueOwner(plan.github);
    } else if (action.type === "slack.notify_ownership_correction" && plan.slack) {
      outcome = await verifyOwnershipNotification(plan.slack);
    } else if (action.type === "notion.update_context" && plan.notion) {
      outcome = await verifyTaskContext(plan.notion);
    } else {
      results.push(failedResult(actionResult, "Verification configuration is missing or unsupported."));
      continue;
    }

    results.push({
      actionId: actionResult.actionId,
      source: actionResult.source,
      status: outcome.verified ? "confirmed" : "failed",
      expectedState: outcome.expectedState,
      actualState: outcome.actualState,
      verified: outcome.verified,
      evidence: [],
      verifiedAt: new Date().toISOString(),
    });
  }

  const verified = results.filter((result) => result.verified).length;
  return {
    status:
      verified === results.length
        ? "succeeded"
        : verified === 0
          ? "failed"
          : "partial_failure",
    results,
  };
}