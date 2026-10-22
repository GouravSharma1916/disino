import { NextResponse } from "next/server";

export function liveDemoDisabledResponse(): NextResponse | null {
  if (process.env.DISINO_ENABLE_LIVE_DEMO === "true") return null;
  return NextResponse.json(
    { error: "The live integration demo is disabled." },
    { status: 403 },
  );
}