import type {
  Action,
  ActionExecutionResult,
  ActionResult,
  OwnershipDecision,
} from "@/domain/contracts";
import {
  updateIssueOwner,
  type GithubOwnershipUpdateRequest,
} from "@/server/integrations/github";
import {
  sendOwnershipNotification,
  type SlackNotificationRequest,
} from "@/server/integrations/slack";
import {
  updateTaskContext,
  type NotionContextUpdateRequest,
} from "@/server/integrations/notion";

export interface CorrectiveActionPlan {
  rescueRequestId?: string;
  decision: OwnershipDecision;
  actions: Action[];
  github?: GithubOwnershipUpdateRequest;
  slack?: SlackNotificationRequest;
  notion?: NotionContextUpdateRequest;
  approved?: boolean;
}

const activeRescueRequests = new Set<string>();
const confirmedRescueRequests = new Set<string>();

export function finalizeRescueRequest(requestId: string, verified: boolean): void {
  activeRescueRequests.delete(requestId);
  if (verified) confirmedRescueRequests.add(requestId);
}

function notAttempted(actions: Action[], message: string): ActionResult[] {
  return actions.map((action) => ({
    actionId: action.id,
    source: sourceFor(action),
    status: "not_attempted",
    message,
  }));
}

function sourceFor(action: Action): "github" | "slack" | "notion" {
  if (action.type.startsWith("github.")) return "github";
  if (action.type.startsWith("slack.")) return "slack";
  return "notion";
}

function resultFor(action: Action, success: boolean, message: string): ActionResult {
  return {
    actionId: action.id,
    source: sourceFor(action),
    status: success ? "succeeded" : "failed",
    message,
  };
}

export async function executeCorrectiveActions(
  plan: CorrectiveActionPlan,
): Promise<ActionExecutionResult> {
  if (
    plan.rescueRequestId &&
    (activeRescueRequests.has(plan.rescueRequestId) || confirmedRescueRequests.has(plan.rescueRequestId))
  ) {
    return {
      status: "blocked",
      results: notAttempted(plan.actions, "Duplicate rescue request was not executed."),
    };
  }
  if (plan.decision.safetyLevel === "LOW") {
    return { status: "blocked", results: notAttempted(plan.actions, "LOW safety does not permit execution.") };
  }
  if (plan.decision.safetyLevel === "MEDIUM" && plan.approved !== true) {
    return { status: "blocked", results: notAttempted(plan.actions, "MEDIUM safety requires explicit approval.") };
  }

  if (plan.rescueRequestId) activeRescueRequests.add(plan.rescueRequestId);

  const results: ActionResult[] = [];
  for (const action of plan.actions) {
    let outcome;
    if (action.type === "github.update_owner" && plan.github) {
      outcome = await updateIssueOwner(plan.github);
    } else if (action.type === "slack.notify_ownership_correction" && plan.slack) {
      outcome = await sendOwnershipNotification({
        ...plan.slack,
        text: `[Disino] Ownership correction: ${plan.slack.text}`,
      });
    } else if (action.type === "notion.update_context" && plan.notion) {
      outcome = await updateTaskContext(plan.notion);
    } else {
      results.push(resultFor(action, false, "Action configuration is missing or unsupported."));
      continue;
    }
    results.push(resultFor(action, outcome.success, outcome.message));
  }

  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const result: ActionExecutionResult = {
    status:
      succeeded === results.length
        ? "succeeded"
        : succeeded === 0
          ? "failed"
          : "partial_failure",
    results,
  };
  if (plan.rescueRequestId) {
    if (result.status !== "succeeded") {
      activeRescueRequests.delete(plan.rescueRequestId);
    }
  }
  return result;
}