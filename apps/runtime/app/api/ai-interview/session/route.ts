import { NextRequest, NextResponse } from "next/server";
import { aiInterviewDeps, errorResponse } from "@/lib/aiInterview/runtimeDeps";
import { resume } from "@/lib/aiInterview/service";

export const dynamic = "force-dynamic";

/** GET ?token=<resume token> — the interview so far, so a reloaded tab (or a phone that slept) carries on. */
export async function GET(req: NextRequest) {
  try {
    const r = await resume(aiInterviewDeps(), req.nextUrl.searchParams.get("token") ?? "");
    return NextResponse.json({ ok: true, ...r }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
