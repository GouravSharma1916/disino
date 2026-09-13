import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  Action,
  OwnershipDecision,
} from "@/domain/contracts";
import { executeCorrectiveActions } from "@/server/actions";
import { investigateOwnership } from "@/server/investigation";
import { enforceSafety } from "@/server/safety";
import { verifyCorrectiveActions } from "@/server/verification";

const now = new Date();
const recent = now.toISOString();
const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

const people = {
  alice: { id: "alice-id", name: "Alice", person: { email: "alice@example.com" } },
  bob: { id: "bob-id", name: "Bob", person: { email: "bob@example.com" } },
};

type Fixture = {
  plannedOwner?: "alice" | "bob";
  handoffs?: Array<{ owner: "alice" | "bob"; timestamp: string; text?: string }>;
  githubActivity?: boolean;
  githubAssignee?: string;
  githubUnavailable?: boolean;
  slackUnavailable?: boolean;
  notionUnavailable?: boolean;
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(fixture: Fixture): void {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("notion.so")) return response({});
    if (url.includes("/pages/") && method === "GET") {
      if (fixture.notionUnavailable) return response({}, 503);
      return response({
        id: "page-1",
        last_edited_time: recent,
        properties: {
          Owner: fixture.plannedOwner ? { people: [people[fixture.plannedOwner]] } : { people: [] },
          Release: { rich_text: [{ plain_text: "R1" }] },
        },
      });
    }
    if (url.includes("/issues/1/timeline")) {
      if (fixture.githubUnavailable) return response({}, 503);
      return response(fixture.githubActivity ? [{ event: "committed", created_at: recent, actor: people.alice }] : []);
    }
    if (url.includes("/issues/1") && method === "GET") {
      if (fixture.githubUnavailable) return response({}, 503);
      return response({
        title: "Critical task",
        body: "Task context",
        updated_at: recent,
        assignees: fixture.githubAssignee ? [{ login: fixture.githubAssignee }] : [],
      });
    }
    if (url.includes("api.github.com") && method === "PATCH") {
      return response({ id: "issue-1", assignees: [{ login: "alice" }] });
    }
    if (url.includes("conversations.history")) {
      if (fixture.slackUnavailable) return response({}, 503);
      const matches = (fixture.handoffs ?? []).map((handoff) => ({
        ts: String(new Date(handoff.timestamp).getTime() / 1000),
        text: handoff.text ?? `I handed off ownership to ${handoff.owner}.`,
        name: handoff.owner === "alice" ? "Alice" : "Bob",
        username: handoff.owner,
      }));
      return response({ ok: true, messages: matches });
    }
    if (url.includes("chat.postMessage")) return response({ ok: true, ts: "123.456" });
    if (url.includes("/pages/") && method === "PATCH") return response({ id: "page-1" });
    return response({}, 404);
  };
}

function request() {
  return {
    investigationId: `investigation-${Math.random()}`,
    taskId: "task-1",
    notionPageId: "page-1",
    github: { owner: "org", repository: "repo", issueNumber: 1 },
    slack: { query: "task-1 ownership" },
  };
}

function action(id: string, type = "github.update_owner"): Action {
  return {
    id,
    type,
    target: "task-1",
    reason: "Correct ownership drift",
    status: "not_started",
    requiresApproval: false,
  };
}

function highDecision(): OwnershipDecision {
  return {
    plannedOwner: { name: "Alice", handle: "alice" },
    operationalOwner: { name: "Bob", handle: "bob" },
    confidence: 0.95,
    safetyLevel: "HIGH",
    supportingEvidence: [],
    conflictingEvidence: [],
    missingEvidence: [],
    reasoning: "Recent explicit handoff.",
    challenge: "A contradictory recent handoff could disprove this.",
    recommendedAction: action("decision-action"),
    verificationRequirements: [],
  };
}

describe("Disino deterministic evaluation", () => {
  beforeEach(() => {
    process.env.NOTION_API_KEY = "notion-test";
    process.env.NOTION_VERSION = "2022-06-28";
    process.env.GITHUB_TOKEN = "github-test";
    process.env.SLACK_BOT_TOKEN = "slack-test";
    process.env.DISINO_SLACK_CHANNEL = "C-demo";
  });

  afterEach(() => {
    process.env.NOTION_API_KEY = "";
    process.env.NOTION_VERSION = "";
    process.env.GITHUB_TOKEN = "";
    process.env.SLACK_BOT_TOKEN = "";
    process.env.DISINO_SLACK_CHANNEL = "";
  });

  const investigate = async (fixture: Fixture) => {
    installFetch(fixture);
    return investigateOwnership(request());
  };

  it("clear recent handoff is HIGH and safety allows the action", async () => {
    const result = await investigate({ plannedOwner: "alice", handoffs: [{ owner: "bob", timestamp: recent }], githubActivity: true });
    assert.equal(result.ownershipDecision.safetyLevel, "HIGH");
    const decision = enforceSafety({ ...highDecision(), safetyLevel: result.ownershipDecision.safetyLevel });
    assert.equal(decision.recommendedAction?.status, "not_started");
  });

  it("handoff with weak GitHub support stays cautious", async () => {
    const result = await investigate({ plannedOwner: "alice", handoffs: [{ owner: "bob", timestamp: recent }] });
    assert.equal(result.ownershipDecision.safetyLevel, "LOW");
    assert.equal(result.ownershipDecision.operationalOwner?.name, "Bob");
  });

  it("GitHub activity alone does not assign ownership", async () => {
    const result = await investigate({ githubActivity: true });
    assert.equal(result.ownershipDecision.operationalOwner, undefined);
    assert.equal(result.ownershipDecision.safetyLevel, "LOW");
  });

  it("conflicting Slack evidence blocks unsafe action", async () => {
    const result = await investigate({ plannedOwner: "alice", handoffs: [{ owner: "bob", timestamp: recent }, { owner: "alice", timestamp: recent }], githubActivity: true });
    assert.ok(result.conflictingEvidence.length > 0);
    assert.equal(result.ownershipDecision.safetyLevel, "LOW");
  });

  it("old handoff and new planned activity lowers confidence", async () => {
    const result = await investigate({ plannedOwner: "alice", handoffs: [{ owner: "bob", timestamp: old }], githubActivity: true, githubAssignee: "alice" });
    assert.equal(result.ownershipDecision.operationalOwner, undefined);
    assert.equal(result.ownershipDecision.safetyLevel, "LOW");
  });

  it("no ownership evidence is LOW with no action", async () => {
    const result = await investigate({});
    assert.equal(result.ownershipDecision.safetyLevel, "LOW");
    assert.equal(enforceSafety({ ...highDecision(), safetyLevel: "LOW" }).recommendedAction, undefined);
  });

  it("multiple contributors remain uncertain", async () => {
    const result = await investigate({ githubActivity: true });
    assert.equal(result.ownershipDecision.operationalOwner, undefined);
    assert.ok(result.ownershipDecision.confidence < 0.8);
  });

  it("a clearly planned owner does not trigger a rescue", async () => {
    const result = await investigate({ plannedOwner: "alice", githubActivity: true, githubAssignee: "alice" });
    assert.equal(result.ownershipDecision.operationalOwner, undefined);
    assert.equal(result.ownershipDecision.safetyLevel, "LOW");
  });

  it("reports GitHub, Slack, and Notion outages as failures", async () => {
    for (const fixture of [{ githubUnavailable: true }, { slackUnavailable: true }, { notionUnavailable: true }]) {
      const result = await investigate(fixture);
      assert.ok(result.evidence.some((item) => item.type === "integration_error"));
      assert.equal(result.status, "blocked");
    }
  });

  it("reports failed actions and failed fresh verification", async () => {
    const failedAction = action("failed-action");
    installFetch({});
    globalThis.fetch = async (input, init) =>
      String(input).includes("api.github.com") && init?.method === "PATCH"
        ? response({}, 500)
        : response({});
    const execution = await executeCorrectiveActions({
      rescueRequestId: "failed-action-request",
      decision: highDecision(),
      actions: [failedAction],
      github: { owner: "org", repository: "repo", issueNumber: 1, assignee: "alice" },
    });
    assert.equal(execution.status, "failed");
    assert.equal(execution.results[0]?.status, "failed");

    const verification = await verifyCorrectiveActions({
      actionExecution: {
        status: "succeeded",
        results: [{ actionId: "verify-action", source: "github", status: "succeeded", message: "confirmed" }],
      },
      actions: [{ id: "verify-action", type: "github.update_owner" }],
      github: { owner: "org", repository: "repo", issueNumber: 1, assignee: "alice" },
    });
    assert.equal(verification.status, "failed");
    assert.equal(verification.results[0]?.verified, false);
  });

  it("allows a failed rescue request to be retried", async () => {
    let attempts = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("api.github.com") && init?.method === "PATCH") {
        attempts += 1;
        return attempts === 1 ? response({}, 500) : response({ id: "issue-1", assignees: [{ login: "alice" }] });
      }
      return response({});
    };
    const plan = {
      rescueRequestId: "retry-failed-request",
      decision: highDecision(),
      actions: [action("retry-failed-action")],
      github: { owner: "org", repository: "repo", issueNumber: 1, assignee: "alice" },
    };
    assert.equal((await executeCorrectiveActions(plan)).status, "failed");
    assert.equal((await executeCorrectiveActions(plan)).status, "succeeded");
    assert.equal(attempts, 2);
  });

  it("allows a partial rescue request to be retried", async () => {
    let attempts = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("api.github.com") && init?.method === "PATCH") {
        attempts += 1;
        return response({ id: "issue-1", assignees: [{ login: "alice" }] });
      }
      if (String(input).includes("chat.postMessage")) {
        return attempts === 1 ? response({ ok: false, error: "temporary_failure" }) : response({ ok: true, ts: "123.456" });
      }
      return response({ id: "page-1" });
    };
    const plan = {
      rescueRequestId: "retry-partial-request",
      decision: highDecision(),
      actions: [action("retry-partial-github"), action("retry-partial-slack", "slack.notify_ownership_correction")],
      github: { owner: "org", repository: "repo", issueNumber: 1, assignee: "alice" },
      slack: { channel: "engineering", text: "Owner confirmed." },
    };
    assert.equal((await executeCorrectiveActions(plan)).status, "partial_failure");
    assert.equal((await executeCorrectiveActions(plan)).status, "succeeded");
  });

  it("blocks a duplicate rescue request", async () => {
    let patchCount = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("api.github.com") && init?.method === "PATCH") patchCount += 1;
      return response({ id: "issue-1", assignees: [{ login: "alice" }] });
    };
    const plan = {
      rescueRequestId: "duplicate-request",
      decision: highDecision(),
      actions: [action("duplicate-action")],
      github: { owner: "org", repository: "repo", issueNumber: 1, assignee: "alice" },
    };
    const first = await executeCorrectiveActions(plan);
    const second = await executeCorrectiveActions(plan);
    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "blocked");
    assert.equal(patchCount, 1);
  });

  it("allows a fresh investigation rescue after a prior rescue for the same owner", async () => {
    let patchCount = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("api.github.com") && init?.method === "PATCH") patchCount += 1;
      return response({ id: "issue-1", assignees: [{ login: "alice" }] });
    };
    const firstInvestigationPlan = {
      rescueRequestId: "fresh-investigation-1",
      decision: highDecision(),
      actions: [action("fresh-investigation-action-1")],
      github: { owner: "org", repository: "repo", issueNumber: 1, assignee: "alice" },
    };
    const secondInvestigationPlan = {
      ...firstInvestigationPlan,
      rescueRequestId: "fresh-investigation-2",
      actions: [action("fresh-investigation-action-2")],
    };
    assert.equal((await executeCorrectiveActions(firstInvestigationPlan)).status, "succeeded");
    assert.equal((await executeCorrectiveActions(secondInvestigationPlan)).status, "succeeded");
    assert.equal(patchCount, 2);
  });
});