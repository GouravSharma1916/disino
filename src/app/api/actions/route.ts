import { NextResponse } from "next/server";
import type { OwnershipDecision } from "@/domain/contracts";
import { executeCorrectiveActions } from "@/server/actions";

export async function POST(request: Request) {
  const body = (await request.json()) as { investigationId?: string; decision?: OwnershipDecision; approved?: boolean };
  if (!body.decision) return NextResponse.json({ error: "A decision is required." }, { status: 400 });
  if (!body.investigationId) return NextResponse.json({ error: "An investigation ID is required." }, { status: 400 });

  const owner = body.decision.operationalOwner?.handle ?? body.decision.operationalOwner?.name;
  const githubOperationalOwner = process.env.DISINO_GITHUB_OPERATIONAL_OWNER ?? "";
  const actions = owner
    ? [
        { id: "github-owner", type: "github.update_owner", target: "release-task", reason: "Align GitHub ownership with operational evidence.", status: "not_started" as const, requiresApproval: false },
        { id: "slack-notification", type: "slack.notify_ownership_correction", target: "engineering-release", reason: "Notify the team about the confirmed ownership correction.", status: "not_started" as const, requiresApproval: false },
        { id: "notion-context", type: "notion.update_context", target: "release-task", reason: "Record the confirmed operational owner in project context.", status: "not_started" as const, requiresApproval: false },
      ]
    : [];

  const result = await executeCorrectiveActions({
    rescueRequestId: body.investigationId,
    decision: body.decision,
    actions,
    approved: body.approved === true,
    github: {
      owner: process.env.DISINO_GITHUB_OWNER ?? "",
      repository: process.env.DISINO_GITHUB_REPOSITORY ?? "",
      issueNumber: Number(process.env.DISINO_GITHUB_ISSUE ?? ""),
      assignee: githubOperationalOwner,
    },
    slack: {
      channel: process.env.DISINO_SLACK_CHANNEL ?? "",
      text: `Operational owner confirmed as ${owner ?? "unassigned"}.`,
    },
    notion: {
      pageId: process.env.DISINO_NOTION_PAGE_ID ?? "",
      properties: process.env.DISINO_NOTION_OWNER_PROPERTY
        ? { [process.env.DISINO_NOTION_OWNER_PROPERTY]: { rich_text: [{ text: { content: owner ?? "" } }] } }
        : {},
    },
  });
  return NextResponse.json({
    ...result,
    verification: {
      actions,
      github: {
        owner: process.env.DISINO_GITHUB_OWNER ?? "",
        repository: process.env.DISINO_GITHUB_REPOSITORY ?? "",
        issueNumber: Number(process.env.DISINO_GITHUB_ISSUE ?? ""),
        assignee: githubOperationalOwner,
      },
      slack: {
        channel: process.env.DISINO_SLACK_CHANNEL ?? "",
        text: `Operational owner confirmed as ${owner ?? "unassigned"}.`,
      },
      notion: {
        pageId: process.env.DISINO_NOTION_PAGE_ID ?? "",
        properties: process.env.DISINO_NOTION_OWNER_PROPERTY
          ? { [process.env.DISINO_NOTION_OWNER_PROPERTY]: { rich_text: [{ text: { content: owner ?? "" } }] } }
          : {},
      },
    },
  }, { status: result.status === "blocked" ? 403 : 200 });
}