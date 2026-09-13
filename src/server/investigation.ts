import type {
  ActorReference,
  Evidence,
  InvestigationResult,
  OwnershipDecision,
} from "@/domain/contracts";
import { getActivityEvidence, type GithubActivityRequest } from "@/server/integrations/github";
import { getTaskContext } from "@/server/integrations/notion";
import {
  searchOwnershipEvidence,
  type SlackSearchRequest,
} from "@/server/integrations/slack";
import type { IntegrationResult } from "@/server/integrations/types";

export interface InvestigationRequest {
  investigationId: string;
  taskId: string;
  notionPageId: string;
  github: GithubActivityRequest;
  slack: SlackSearchRequest;
}

export type InvestigationProgress =
  | "Understanding project context"
  | "Investigating engineering activity"
  | "Checking team communication"
  | "Resolving evidence";

const HANDOFF_PATTERN =
  /\b(hand(?:ed|ing)?\s+off|handoff|take(?:n|ing)?\s+over|owns?|owner\s+is|assigned\s+to|picked\s+up)\b/i;

function actorKey(actor: ActorReference | undefined): string | undefined {
  if (!actor) return undefined;
  return (actor.id ?? actor.handle ?? actor.name)?.trim().toLowerCase();
}

function actorLabel(actor: ActorReference | undefined): string {
  return actor?.name ?? actor?.handle ?? actor?.id ?? "an unidentified person";
}

function actorMatches(left: ActorReference | undefined, right: ActorReference | undefined): boolean {
  const leftKey = actorKey(left);
  const rightKey = actorKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function errorEvidence(
  source: Evidence["source"],
  taskId: string,
  errors: string[],
): Evidence[] {
  return errors.map((error, index) => ({
    id: `${source}-error-${taskId}-${index}`,
    source,
    type: "integration_error",
    content: "",
    timestamp: new Date().toISOString(),
    relatedTask: taskId,
    confidence: 1,
    relevance: 1,
    availability: "missing",
    missingReason: error,
  }));
}

function missingEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.filter((item) => item.availability === "missing");
}

function handoffEvidence(evidence: Evidence[]): Evidence[] {
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return evidence.filter(
    (item) =>
      item.source === "slack" &&
      item.availability === "available" &&
      Boolean(item.person) &&
      Date.parse(item.timestamp) >= recentCutoff &&
      HANDOFF_PATTERN.test(item.content),
  );
}

function createDecision(
  plannedOwner: ActorReference | undefined,
  evidence: Evidence[],
): OwnershipDecision {
  const handoffs = handoffEvidence(evidence).sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  );
  const operationalOwner = handoffs[0]?.person;
  const githubActivity = evidence.filter(
    (item) => item.source === "github" && item.availability === "available",
  );
  const missing = missingEvidence(evidence);
  const handoffOwners = new Set(
    handoffs.map((item) => actorKey(item.person)).filter((key): key is string => Boolean(key)),
  );
  const conflictingEvidence = [
    ...(handoffOwners.size > 1 ? handoffs : []),
    ...evidence.filter((item) => item.availability === "conflicting"),
  ];
  const supportingEvidence = operationalOwner
    ? handoffs
    : evidence.filter((item) => item.source === "notion" && item.availability === "available");

  let confidence = 0.35;
  const reasoning: string[] = [];

  if (plannedOwner) {
    reasoning.push(`Notion lists ${actorLabel(plannedOwner)} as the planned owner.`);
    confidence += 0.2;
  } else {
    reasoning.push("No planned owner was confirmed from Notion.");
    confidence -= 0.15;
  }

  if (githubActivity.length > 0) {
    reasoning.push("GitHub activity confirms engineering work, but does not prove ownership.");
  } else {
    reasoning.push("No usable GitHub activity was found.");
    confidence -= 0.1;
  }

  if (operationalOwner) {
    reasoning.push(`A recent Slack handoff identifies ${actorLabel(operationalOwner)} as operational owner.`);
    confidence += 0.35;
    if (plannedOwner && !actorMatches(operationalOwner, plannedOwner)) {
      reasoning.push("The operational owner differs from the planned owner, indicating ownership drift.");
    }
  } else {
    reasoning.push("No explicit Slack handoff was found, so operational ownership remains unconfirmed.");
    confidence -= 0.2;
  }

  if (conflictingEvidence.length > 0) {
    reasoning.push("Planned and operational ownership conflict.");
    confidence -= 0.25;
  }

  if (missing.length > 0) {
    reasoning.push(`${missing.length} evidence item(s) are missing or unavailable.`);
    confidence -= Math.min(0.2, missing.length * 0.05);
  }

  const boundedConfidence = Math.max(0, Math.min(1, confidence));
  return {
    plannedOwner,
    operationalOwner,
    confidence: boundedConfidence,
    safetyLevel: boundedConfidence >= 0.9 && conflictingEvidence.length === 0 ? "HIGH" : "LOW",
    supportingEvidence,
    conflictingEvidence,
    missingEvidence: missing,
    reasoning: reasoning.join(" "),
    challenge: "An explicit, recent Slack handoff naming a different owner could disprove this conclusion.",
    verificationRequirements: [],
  };
}

function appendResult(
  allEvidence: Evidence[],
  result: IntegrationResult,
  source: Evidence["source"],
  taskId: string,
): void {
  allEvidence.push(...result.evidence, ...errorEvidence(source, taskId, result.errors));
}

export async function investigateOwnership(
  request: InvestigationRequest,
  onProgress?: (progress: InvestigationProgress) => void,
): Promise<InvestigationResult> {
  const evidence: Evidence[] = [];
  onProgress?.("Understanding project context");
  const notionResult = await getTaskContext(request.notionPageId);
  appendResult(evidence, notionResult, "notion", request.taskId);

  const plannedOwner = notionResult.evidence.find(
    (item) => item.type === "planned_task_context" && item.person,
  )?.person;

  onProgress?.("Investigating engineering activity");
  const githubResult = await getActivityEvidence(request.github);
  appendResult(evidence, githubResult, "github", request.taskId);

  onProgress?.("Checking team communication");
  const slackResult = await searchOwnershipEvidence({
    ...request.slack,
    taskId: request.taskId,
  });
  appendResult(evidence, slackResult, "slack", request.taskId);

  onProgress?.("Resolving evidence");
  const decision = createDecision(plannedOwner, evidence);
  const missing = missingEvidence(evidence);
  const conflicting = decision.conflictingEvidence;
  const hasErrors = evidence.some((item) => item.type === "integration_error");

  return {
    investigationId: request.investigationId,
    taskId: request.taskId,
    status: hasErrors || missing.length > 0 || decision.confidence < 0.8 ? "blocked" : "complete",
    evidence,
    missingEvidence: missing,
    conflictingEvidence: conflicting,
    ownershipDecision: decision,
    createdAt: new Date().toISOString(),
  };
}