import { NextRequest, NextResponse } from "next/server";
import { aiInterviewDeps, errorResponse } from "@/lib/aiInterview/runtimeDeps";
import { studyInfo } from "@/lib/aiInterview/service";

export const dynamic = "force-dynamic";

/**
 * GET ?token=<link token>[&test=<test token>] — what the participant's page shows before the
 * interview: title, consent statement and recording disclosure, screener questions (never which
 * answers qualify), modes, languages, the time it takes. 404 for an unknown link; `open: false` with
 * the reason for a paused or closed study.
 */
export async function GET(req: NextRequest) {
  try {
    const r = await studyInfo(aiInterviewDeps(), req.nextUrl.searchParams.get("token") ?? "", req.nextUrl.searchParams.get("test"));
    return NextResponse.json({ ok: true, ...r }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
