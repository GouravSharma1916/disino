import { NextResponse } from "next/server";
import type { ActionExecutionResult } from "@/domain/contracts";
import { finalizeRescueRequest } from "@/server/actions";
import { verifyCorrectiveActions } from "@/server/verification";
import { liveDemoDisabledResponse } from "@/server/live-demo";

export async function POST(request: Request) {
  const disabledResponse = liveDemoDisabledResponse();
  if (disabledResponse) return disabledResponse;

  const body = (await request.json()) as { actionExecution?: ActionExecutionResult; rescueRequestId?: string; verification?: { actions: Array<{ id: string; type: string }>; github?: Parameters<typeof verifyCorrectiveActions>[0]["github"]; slack?: Parameters<typeof verifyCorrectiveActions>[0]["slack"]; notion?: Parameters<typeof verifyCorrectiveActions>[0]["notion"] } };
  if (!body.actionExecution) return NextResponse.json({ error: "Action execution is required." }, { status: 400 });

  const result = await verifyCorrectiveActions({
    actionExecution: body.actionExecution,
    actions: body.verification?.actions ?? [],
    github: body.verification?.github,
    slack: body.verification?.slack,
    notion: body.verification?.notion,
  });
  if (body.rescueRequestId) finalizeRescueRequest(body.rescueRequestId, result.status === "succeeded");
  return NextResponse.json(result, { status: result.status === "succeeded" ? 200 : 502 });
}