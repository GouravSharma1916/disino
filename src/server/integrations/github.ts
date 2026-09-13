import type { ActorReference, Evidence } from "@/domain/contracts";
import type {
  ExternalActionResult,
  ExternalVerificationResult,
  IntegrationResult,
} from "./types";

const GITHUB_API_URL = "https://api.github.com";

type GithubRecord = Record<string, unknown>;

function asRecord(value: unknown): GithubRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as GithubRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function actor(value: unknown): ActorReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    id: typeof record.id === "number" ? String(record.id) : asString(record.id),
    name: asString(record.name),
    handle: asString(record.login),
  };
}

function missingEvidence(taskId: string, reason: string): Evidence {
  return {
    id: `github-missing-${taskId}`,
    source: "github",
    type: "missing_activity",
    content: "",
    timestamp: new Date().toISOString(),
    relatedTask: taskId,
    confidence: 1,
    relevance: 1,
    availability: "missing",
    missingReason: reason,
  };
}

export interface GithubActivityRequest {
  owner: string;
  repository: string;
  issueNumber: number;
}

export async function getActivityEvidence(
  request: GithubActivityRequest,
): Promise<IntegrationResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { evidence: [], errors: ["GitHub credentials are not configured."] };
  }

  const { owner, repository, issueNumber } = request;
  if (!owner || !repository || !Number.isInteger(issueNumber)) {
    return { evidence: [], errors: ["A GitHub owner, repository, and issue number are required."] };
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const basePath = `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;

  try {
    const [issueResponse, timelineResponse] = await Promise.all([
      fetch(`${basePath}/issues/${issueNumber}`, { headers }),
      fetch(`${basePath}/issues/${issueNumber}/timeline`, { headers }),
    ]);

    if (!issueResponse.ok || !timelineResponse.ok) {
      const failedStatus = !issueResponse.ok ? issueResponse.status : timelineResponse.status;
      return { evidence: [], errors: [`GitHub returned HTTP ${failedStatus}.`] };
    }

    const issue = asRecord(await issueResponse.json());
    const timeline = await timelineResponse.json();
    if (!issue || !Array.isArray(timeline)) {
      return { evidence: [missingEvidence(String(issueNumber), "GitHub returned no activity data.")], errors: [] };
    }

    const taskId = `github:${owner}/${repository}#${issueNumber}`;
    const evidence: Evidence[] = [
      {
        id: `github-issue-${owner}-${repository}-${issueNumber}`,
        source: "github",
        type: "issue_or_pull_request",
        content: [asString(issue.title), asString(issue.body)].filter(Boolean).join("\n\n"),
        timestamp: asString(issue.updated_at) ?? new Date().toISOString(),
        relatedTask: taskId,
        person: actor(issue.assignee),
        confidence: 1,
        relevance: 1,
        availability: "available",
      },
    ];

    for (const [index, item] of timeline.entries()) {
      const event = asRecord(item);
      if (!event) continue;
      const eventType = asString(event.event) ?? "activity";
      const eventActor = actor(event.actor) ?? actor(event.user);
      const timestamp = asString(event.created_at) ?? asString(event.submitted_at);
      if (!timestamp) continue;

      evidence.push({
        id: `github-activity-${issueNumber}-${index}`,
        source: "github",
        type: eventType,
        content: JSON.stringify(item),
        timestamp,
        relatedTask: taskId,
        person: eventActor,
        confidence: 1,
        relevance: 0.8,
        availability: "available",
      });
    }

    if (timeline.length === 0) {
      evidence.push(missingEvidence(taskId, "No GitHub timeline activity was found."));
    }

    return { evidence, errors: [] };
  } catch {
    return { evidence: [], errors: ["GitHub request failed before a response was received."] };
  }
}

export interface GithubOwnershipUpdateRequest {
  owner: string;
  repository: string;
  issueNumber: number;
  assignee: string;
}

export async function updateIssueOwner(
  request: GithubOwnershipUpdateRequest,
): Promise<ExternalActionResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { success: false, message: "GitHub credentials are not configured." };

  if (!request.assignee) {
    return { success: false, message: "DISINO_GITHUB_OPERATIONAL_OWNER is not configured." };
  }
  if (!request.owner || !request.repository || !Number.isInteger(request.issueNumber)) {
    return { success: false, message: "A GitHub issue is required." };
  }

  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repository)}/issues/${request.issueNumber}`,
      {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ assignees: [request.assignee] }),
      },
    );

    if (!response.ok) return { success: false, message: `GitHub returned HTTP ${response.status}.` };
    const updatedIssue = asRecord(await response.json());
    const assignees = updatedIssue?.assignees;
    if (!Array.isArray(assignees)) {
      return { success: false, message: "GitHub did not confirm the updated assignee." };
    }

    return { success: true, message: "GitHub confirmed the issue ownership update." };
  } catch {
    return { success: false, message: "GitHub action failed before confirmation." };
  }
}

export async function verifyIssueOwner(
  request: GithubOwnershipUpdateRequest,
): Promise<ExternalVerificationResult> {
  const token = process.env.GITHUB_TOKEN;
  const expectedState = `issue assignee is ${request.assignee}`;
  if (!token) {
    return { verified: false, expectedState, actualState: "GitHub credentials are not configured." };
  }

  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repository)}/issues/${request.issueNumber}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      return { verified: false, expectedState, actualState: `GitHub returned HTTP ${response.status}.` };
    }

    const issue = asRecord(await response.json());
    const assignees = Array.isArray(issue?.assignees) ? issue.assignees : [];
    const actualAssignees = assignees
      .map((item) => asString(asRecord(item)?.login))
      .filter((item): item is string => Boolean(item));
    return {
      verified: actualAssignees.includes(request.assignee),
      expectedState,
      actualState: `issue assignees are ${actualAssignees.join(", ") || "none"}`,
    };
  } catch {
    return { verified: false, expectedState, actualState: "GitHub verification failed before a response." };
  }
}