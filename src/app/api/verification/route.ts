import { NextResponse } from "next/server";
import type { ActionExecutionResult } from "@/domain/contracts";
import { verifyCorrectiveActions } from "@/server/verification";

export async function POST(request: Request) {
  const body = (await request.json()) as { actionExecution?: ActionExecutionResult; verification?: { actions: Array<{ id: string; type: string }>; github?: Parameters<typeof verifyCorrectiveActions>[0]["github"]; slack?: Parameters<typeof verifyCorrectiveActions>[0]["slack"]; notion?: Parameters<typeof verifyCorrectiveActions>[0]["notion"] } };
  if (!body.actionExecution) return NextResponse.json({ error: "Action execution is required." }, { status: 400 });

  const result = await verifyCorrectiveActions({
    actionExecution: body.actionExecution,
    actions: body.verification?.actions ?? [],
    github: body.verification?.github,
    slack: body.verification?.slack,
    notion: body.verification?.notion,
  });
  return NextResponse.json(result, { status: result.status === "succeeded" ? 200 : 502 });
}