import { NextResponse } from "next/server";
import { investigateOwnership } from "@/server/investigation";
import { enforceSafety } from "@/server/safety";
import { reasonAboutInvestigation } from "@/server/ai/reasoning";

export async function POST() {
  const required = {
    taskId: process.env.DISINO_TASK_ID,
    notionPageId: process.env.DISINO_NOTION_PAGE_ID,
    githubOwner: process.env.DISINO_GITHUB_OWNER,
    githubRepository: process.env.DISINO_GITHUB_REPOSITORY,
    githubIssue: process.env.DISINO_GITHUB_ISSUE,
    slackQuery: process.env.DISINO_SLACK_QUERY,
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing Disino configuration: ${missing.join(", ")}.` }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const send = (event: Record<string, unknown>) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`));

  void (async () => {
    try {
      const investigation = await investigateOwnership({
    investigationId: crypto.randomUUID(),
    taskId: required.taskId!,
    notionPageId: required.notionPageId!,
    github: {
      owner: required.githubOwner!,
      repository: required.githubRepository!,
      issueNumber: Number(required.githubIssue),
    },
    slack: {
      query: required.slackQuery!,
    },
      }, (progress) => { void send({ type: "progress", stage: progress }); });

      await send({ type: "progress", stage: "Evaluating safe action" });
      const aiResult = await reasonAboutInvestigation(investigation);
      const decision = enforceSafety(aiResult.decision ?? investigation.ownershipDecision);
      await send({ type: "result", payload: { ...investigation, ownershipDecision: decision, aiError: aiResult.error } });
    } catch (error) {
      await send({ type: "error", error: error instanceof Error ? error.message : "Investigation failed." });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
}